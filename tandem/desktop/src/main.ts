import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig, type Config } from './config';
import { commandMenuItem, controlCommands, editCommands, navigationCommands, tabCommands } from './commands';
import { isDesktopPopup, isExternalURL, isSameOrigin, validateServerURL } from './policy';

const brand = JSON.parse(readFileSync(path.join(__dirname, 'brand.json'), 'utf8'));
const smoke = process.env.TANDEM_SMOKE === '1' || process.argv.includes('--smoke');
const smokeURL = process.env.TANDEM_SMOKE_URL ?? process.argv.find(arg => arg.startsWith('--smoke-url='))?.slice(12);
const devTools = !app.isPackaged || process.env.TANDEM_DEVTOOLS === '1';
const pages = path.join(__dirname, 'pages');
const localURL = (name: string) => pathToFileURL(path.join(pages, `${name}.html`)).href;
app.setName(brand.productName);
if (smoke) app.setPath('userData', process.env.TANDEM_SMOKE_DATA_DIR ?? path.join(app.getPath('temp'), `${brand.appId}-smoke-${process.pid}`));

let config: Config = {};
let configFile: string;
let mainWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let quitting = false;
let saveQueue = Promise.resolve();
const viewers = new Map<number, { window: BrowserWindow; origin: string; url: string; desktop: boolean }>();
const localWindows = new Set<number>();
const pendingErrors = new WeakSet<BrowserWindow>();
const persist = () => {
  const snapshot = structuredClone(config);
  saveQueue = saveQueue.catch(() => {}).then(() => saveConfig(configFile, snapshot));
  return saveQueue;
};

function external(url: string) {
  if (isExternalURL(url) && !smoke) void shell.openExternal(url).catch(() => {});
}

function guardNavigation(win: BrowserWindow, origin?: string) {
  const allowed = (url: string) => origin ? isSameOrigin(url, origin) : [localURL('settings'), localURL('about')].includes(url);
  win.webContents.on('will-frame-navigate', (event) => {
    if (!allowed(event.url)) { event.preventDefault(); if (event.isMainFrame) external(event.url); }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!allowed(url)) { event.preventDefault(); external(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (origin && isDesktopPopup(url, origin)) createViewer(url, true);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}

function remoteSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const viewer = viewers.get(event.sender.id);
  return Boolean(viewer && event.senderFrame === event.sender.mainFrame && isSameOrigin(event.senderFrame.url, viewer.origin));
}

function localSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame &&
    ((localWindows.has(event.sender.id) && [localURL('settings'), localURL('about')].includes(event.senderFrame.url)) ||
    (viewers.has(event.sender.id) && event.senderFrame.url === localURL('error')));
}

async function health(input: unknown) {
  const url = validateServerURL(input);
  const response = await fetch(`${url}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
  const data = await response.json() as { ok?: boolean; cdp?: boolean; mcp?: boolean; version?: string };
  if (data.ok !== true || typeof data.cdp !== 'boolean' || typeof data.mcp !== 'boolean') throw new Error('The server did not return a healthy Tandem response.');
  return { url, cdp: data.cdp, mcp: data.mcp, version: typeof data.version === 'string' ? data.version : '' };
}

function installIPC() {
  ipcMain.on('tandem:clipboard-read', event => { event.returnValue = remoteSender(event) ? clipboard.readText() : ''; });
  ipcMain.on('tandem:clipboard-write', (event, text) => {
    if (remoteSender(event) && typeof text === 'string') clipboard.writeText(text);
    event.returnValue = undefined;
  });
  ipcMain.on('tandem:settings', event => { if (remoteSender(event)) openSettings(); });
  ipcMain.handle('local:config', event => {
    if (!localSender(event)) throw new Error('Denied');
    return { serverURL: config.serverURL ?? '', version: app.getVersion() };
  });
  ipcMain.handle('local:health', async (event, input) => {
    if (!localSender(event)) throw new Error('Denied');
    try { return { ok: true, ...await health(input) }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  ipcMain.handle('local:save', async (event, input) => {
    if (!localSender(event) || event.sender !== settingsWindow?.webContents) throw new Error('Denied');
    try {
      const result = await health(input);
      config.serverURL = result.url;
      await persist();
      for (const viewer of [...viewers.values()]) viewer.window.close();
      createViewer(result.url);
      setImmediate(() => settingsWindow?.close());
      return { ok: true };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
  });
  ipcMain.on('local:retry', event => {
    const viewer = viewers.get(event.sender.id);
    if (localSender(event) && viewer) loadViewer(viewer.window, viewer.url);
  });
  ipcMain.on('local:settings', event => { if (localSender(event)) openSettings(); });
  ipcMain.on('local:source', event => { if (localSender(event)) external(brand.repository); });
}

function installPermissions() {
  const browserSession = session.fromPartition('persist:tandem');
  const allowed = (contents: WebContents | null, permission: string, origin: string, mainFrame: boolean) => {
    const viewer = contents && viewers.get(contents.id);
    return Boolean(viewer && mainFrame && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission) &&
      isSameOrigin(origin, viewer.origin) && isSameOrigin(contents!.getURL(), viewer.origin));
  };
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed(contents, permission, details.requestingUrl, details.isMainFrame));
  });
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allowed(contents, permission, requestingOrigin, details.isMainFrame === true));
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.on('will-download', event => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => {
    event.preventDefault(); callback(false);
  });
}

function windowBounds() {
  const state = config.window ?? { width: 1280, height: 840 };
  if (state.x === undefined || state.y === undefined) return { width: state.width, height: state.height };
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    state.x! + state.width > a.x + 80 && state.x! < a.x + a.width - 80 && state.y! >= a.y && state.y! < a.y + a.height - 80);
  return visible ? { width: state.width, height: state.height, x: state.x, y: state.y } : { width: state.width, height: state.height };
}

function showError(win: BrowserWindow) {
  if (win.isDestroyed() || pendingErrors.has(win) || win.webContents.getURL() === localURL('error')) return;
  pendingErrors.add(win);
  void win.loadFile(path.join(pages, 'error.html')).catch(() => {}).finally(() => pendingErrors.delete(win));
}

function loadViewer(win: BrowserWindow, url: string) {
  void win.loadURL(url).catch(error => {
    if (error.code !== 'ERR_ABORTED' && error.errno !== -3) showError(win);
  });
}

function createViewer(url: string, desktop = false): BrowserWindow {
  const origin = validateServerURL(new URL(url).origin);
  const win = new BrowserWindow({
    ...windowBounds(), minWidth: 640, minHeight: 480, show: !smoke,
    title: desktop ? 'Desktop view' : brand.productName,
    backgroundColor: brand.colors.background,
    // The viewer's own top bar doubles as the title bar; traffic lights sit in it.
    ...(process.platform === 'darwin' && !desktop ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), partition: 'persist:tandem',
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      devTools, webviewTag: false, navigateOnDragDrop: false,
      additionalArguments: [`--tandem-origin=${origin}`, `--tandem-version=${app.getVersion()}`]
    }
  });
  viewers.set(win.webContents.id, { window: win, origin, url, desktop });
  if (!desktop) mainWindow = win;
  guardNavigation(win, origin);
  win.on('page-title-updated', event => { if (desktop) { event.preventDefault(); win.setTitle('Desktop view'); } });
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) showError(win);
  });
  win.webContents.on('render-process-gone', () => showError(win));
  win.on('close', () => {
    if (!desktop && !smoke && !win.isFullScreen()) {
      config.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      void persist().catch(error => console.error('Could not save window state:', error.message));
    }
  });
  const id = win.webContents.id;
  win.on('closed', () => { viewers.delete(id); if (mainWindow === win) mainWindow = undefined; });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    let command: string | undefined;
    if (input.control && !input.meta && !input.alt && key === 'tab') command = input.shift ? 'prev-tab' : 'next-tab';
    if (process.platform === 'darwin' && input.meta && input.shift && !input.control && !input.alt) {
      if (input.code === 'BracketRight') command = 'next-tab';
      if (input.code === 'BracketLeft') command = 'prev-tab';
    }
    if (process.platform !== 'darwin' && input.alt && !input.control && !input.meta) {
      if (key === 'arrowleft') command = 'back';
      if (key === 'arrowright') command = 'forward';
    }
    if (command) { event.preventDefault(); sendCommand(command, win); }
  });
  if (config.window?.maximized && !smoke) win.maximize();
  loadViewer(win, url);
  return win;
}

function createLocal(name: 'settings' | 'about') {
  const win = new BrowserWindow({
    width: 600, height: name === 'settings' ? 580 : 620, minWidth: 500, minHeight: 480,
    show: !smoke, title: brand.productName, backgroundColor: brand.colors.background,
    webPreferences: { preload: path.join(__dirname, 'local-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools, webviewTag: false }
  });
  const id = win.webContents.id;
  localWindows.add(id);
  win.on('closed', () => localWindows.delete(id));
  guardNavigation(win);
  void win.loadFile(path.join(pages, `${name}.html`));
  return win;
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { if (!smoke) settingsWindow.focus(); return; }
  settingsWindow = createLocal('settings');
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
}

function sendCommand(command: string, target = BrowserWindow.getFocusedWindow() ?? mainWindow) {
  if (!target || target.isDestroyed()) return;
  const viewer = viewers.get(target.webContents.id);
  if (viewer && isSameOrigin(target.webContents.getURL(), viewer.origin)) target.webContents.send('tandem:command', command);
  else if (localWindows.has(target.webContents.id)) {
    const edit = { 'edit-undo': 'undo', 'edit-redo': 'redo', 'edit-cut': 'cut', 'edit-copy': 'copy', 'edit-paste': 'paste', 'edit-select-all': 'selectAll' } as const;
    const action = edit[command as keyof typeof edit];
    if (action) target.webContents[action]();
    if (command === 'close-tab') target.close();
  }
}

function installMenu() {
  const commands = (items: typeof tabCommands) => items.map(item => commandMenuItem(item, command => sendCommand(command)));
  const menu: MenuItemConstructorOptions[] = [];
  const about = { label: `About ${brand.productName}`, click: () => { createLocal('about'); } };
  if (process.platform === 'darwin') menu.push({ label: brand.productName, submenu: [about, { type: 'separator' }, { label: 'Change Server…', accelerator: 'Cmd+,', click: openSettings }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] });
  menu.push({ label: 'File', submenu: [
    ...commands(tabCommands.slice(0, 3)), { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => (BrowserWindow.getFocusedWindow() ?? mainWindow)?.close() },
    { type: 'separator' }, { label: 'Change Server…', click: openSettings },
    ...(process.platform === 'darwin' ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
  ] });
  menu.push({ label: 'Edit', submenu: commands(editCommands) });
  menu.push({ label: 'Navigate', submenu: [
    ...commands(navigationCommands), { type: 'separator' },
    { label: 'Reload App', accelerator: 'CmdOrCtrl+Shift+R', click: () => {
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
      if (win?.webContents.getURL() === localURL('error')) { const viewer = viewers.get(win.webContents.id); if (viewer) loadViewer(win, viewer.url); }
      else win?.webContents.reload();
    } },
    ...(devTools ? [{ label: 'Toggle Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => (BrowserWindow.getFocusedWindow() ?? mainWindow)?.webContents.toggleDevTools() }] : [])
  ] });
  menu.push({ label: 'Tabs', submenu: commands(tabCommands.slice(3)) });
  menu.push({ label: 'Control', submenu: commands(controlCommands(brand.agentName)) });
  menu.push({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] });
  menu.push({ label: 'Help', submenu: [about, { label: 'Source Code (AGPL-3.0)', click: () => external(brand.repository) }] });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

async function runSmoke(win: BrowserWindow) {
  const deadline = Date.now() + 20000;
  const evaluate = () => win.webContents.executeJavaScript(`(() => ({ bridge: typeof window.tandemDesktop, keys: Object.keys(window.tandemDesktop || {}).sort(), platform: window.tandemDesktop?.platform, version: window.tandemDesktop?.version, title: document.title, node: typeof require, localBridge: typeof window.tandemLocal }))()`);
  try {
    let before;
    while (Date.now() < deadline) {
      try { before = await evaluate(); if (before.title === 'smoke:ready') break; } catch { /* Wait for navigation. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (before?.title !== 'smoke:ready') throw new Error('Smoke page did not become ready.');
    const menuItem = Menu.getApplicationMenu()?.getMenuItemById('new-tab');
    if (!menuItem) throw new Error('New Tab menu item missing.');
    menuItem.click();
    let after = await evaluate();
    while (after.title !== 'smoke:command:new-tab' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50)); after = await evaluate();
    }
    const expected = ['isDesktop', 'platform', 'version', 'onCommand', 'writeClipboard', 'readClipboard', 'openSettings'].sort();
    const checks: Record<string, boolean> = {
      bridge: after.bridge === 'object' && JSON.stringify(after.keys) === JSON.stringify(expected),
      menuCommand: after.title === 'smoke:command:new-tab',
      isolated: after.node === 'undefined' && after.localBridge === 'undefined',
      title: win.getTitle() === after.title
    };
    const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
      const until = Date.now() + 8000;
      while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('Smoke security check timed out.');
    };
    checks.permissions = await win.webContents.executeJavaScript(`Promise.all(['geolocation', 'notifications', 'clipboard-read', 'clipboard-write'].map(name => navigator.permissions.query({name}).then(p => p.state))).then(states => states[0] === 'denied' && states[1] === 'denied' && states[2] === 'granted' && states[3] === 'granted')`);
    await win.webContents.executeJavaScript(`window.open(location.origin + '/login'); undefined`);
    await new Promise(resolve => setTimeout(resolve, 100));
    checks.deniedPopup = viewers.size === 1;
    await win.webContents.executeJavaScript(`window.open(location.origin + '/desktop/vnc.html'); undefined`);
    await waitFor(() => [...viewers.values()].some(viewer => viewer.desktop && !viewer.window.webContents.isLoading()));
    const desktop = [...viewers.values()].find(viewer => viewer.desktop)!;
    checks.desktopPopup = desktop.window.getTitle() === 'Desktop view' && desktop.window.webContents.session === win.webContents.session && !desktop.window.isVisible();
    await desktop.window.loadURL('http://127.0.0.1:1').catch(() => {});
    await waitFor(() => desktop.window.webContents.getURL() === localURL('error') && !desktop.window.webContents.isLoading());
    await desktop.window.webContents.executeJavaScript('window.tandemLocal.retry(); undefined');
    await waitFor(() => desktop.window.webContents.getURL() === desktop.url && !desktop.window.webContents.isLoading());
    checks.desktopRetry = desktop.window.getTitle() === 'Desktop view';
    desktop.window.destroy();
    await win.webContents.executeJavaScript('window.tandemDesktop.openSettings(); undefined');
    await waitFor(() => Boolean(settingsWindow && !settingsWindow.webContents.isLoading()));
    const settings = settingsWindow!;
    checks.settings = await settings.webContents.executeJavaScript(`typeof window.tandemDesktop === 'undefined' && typeof window.tandemLocal === 'object'`);
    checks.health = await settings.webContents.executeJavaScript(`window.tandemLocal.health(${JSON.stringify(new URL(smokeURL!).origin)}).then(r => r.ok === true)`);
    checks.healthRejectsUnsafeURL = await settings.webContents.executeJavaScript(`window.tandemLocal.health('http://example.com').then(r => r.ok === false)`);
    settings.destroy();
    const foreignURL = process.env.TANDEM_SMOKE_FOREIGN_URL;
    if (foreignURL) {
      const original = win.webContents.getURL();
      await win.webContents.executeJavaScript(`location.href = ${JSON.stringify(foreignURL)}; undefined`);
      await new Promise(resolve => setTimeout(resolve, 150));
      checks.navigation = win.webContents.getURL() === original;
      await win.loadURL(foreignURL);
      checks.foreignBridgeAbsent = await win.webContents.executeJavaScript(`typeof window.tandemDesktop === 'undefined' && typeof window.tandemLocal === 'undefined'`);
    }
    await win.loadURL('http://127.0.0.1:1').catch(() => {});
    await waitFor(() => win.webContents.getURL() === localURL('error') && !win.webContents.isLoading());
    checks.offline = await win.webContents.executeJavaScript(`typeof window.tandemDesktop === 'undefined' && typeof window.tandemLocal.retry === 'function' && typeof window.tandemLocal.settings === 'function'`);
    await win.webContents.executeJavaScript('window.tandemLocal.retry(); window.tandemLocal.retry(); undefined');
    await waitFor(async () => { try { return (await evaluate()).title === 'smoke:ready'; } catch { return false; } });
    checks.retry = (await evaluate()).bridge === 'object';
    checks.hidden = BrowserWindow.getAllWindows().every(window => !window.isVisible());
    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ smoke: true, ok, hidden: checks.hidden, menuCommand: 'new-tab', checks, ...after }));
    app.exit(ok ? 0 : 1);
  } catch (error) { console.log(JSON.stringify({ smoke: true, ok: false, error: (error as Error).message })); app.exit(1); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const win = settingsWindow ?? mainWindow ?? [...viewers.values()][0]?.window;
    if (win) { if (win.isMinimized()) win.restore(); if (!smoke) { win.show(); win.focus(); } }
    else if (config.serverURL) createViewer(config.serverURL); else openSettings();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !quitting && !smoke) app.quit(); });
  app.on('before-quit', event => {
    if (quitting || smoke) return;
    event.preventDefault(); quitting = true;
    for (const win of BrowserWindow.getAllWindows()) win.close();
    void saveQueue.finally(() => app.quit());
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length) return;
    if (config.serverURL) createViewer(config.serverURL); else openSettings();
  });
  void app.whenReady().then(async () => {
    if (smoke) app.dock?.hide();
    configFile = path.join(app.getPath('userData'), 'config.json');
    config = await loadConfig(configFile);
    installIPC(); installPermissions(); installMenu();
    if (smoke) {
      if (!smokeURL) throw new Error('Set TANDEM_SMOKE_URL or --smoke-url to a smoke fixture origin.');
      const url = validateServerURL(smokeURL);
      await runSmoke(createViewer(url));
    } else if (config.serverURL) createViewer(config.serverURL); else openSettings();
  }).catch(error => {
    if (smoke) console.log(JSON.stringify({ smoke: true, ok: false, error: error.message }));
    else dialog.showErrorBox(brand.productName, error.message);
    app.exit(1);
  });
}
