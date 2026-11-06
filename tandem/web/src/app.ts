import { loadBrand } from './brand';
import { persistStream, readStream } from './neo-transport';
import type { StreamPreference } from './neo-transport';
import { pageTitle } from './title';
import { NeoView } from './neo';
import type { NeoStatus } from './neo';
import { selectView, persistView } from './view';
import type { View } from './view';
import { displayUrl, fitFrame, mapPointer, parseFrame } from './frame';
import { ClickCounter, keyMessage, modifiers, mouseButton, wheelDelta } from './input';
import { commandRoute, selectedTabIndex } from './commands';
import type { Brand, Control, FrameHeader, Message, RemoteDialog, RemoteTab } from './types';
import { BuildWatch } from './update';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('page');
const context = canvas.getContext('2d', { alpha: false })!;
const address = $<HTMLInputElement>('address');
const remoteDialog = $<HTMLDialogElement>('remote-dialog');
const auditDialog = $<HTMLDialogElement>('audit-dialog');
const mac = window.tandemDesktop ? window.tandemDesktop.platform === 'darwin' : /Mac/i.test(navigator.platform);
let brand: Brand;
const viewStorage = { getItem: (key: string) => localStorage.getItem(key), setItem: (key: string, value: string) => localStorage.setItem(key, value) };
let view = selectView(location.search, viewStorage);
let stream = readStream(viewStorage);
let neo: NeoView | undefined;
let neoStatus: NeoStatus = 'connecting';
const logo = document.querySelector<HTMLElement>('.brand-mark')!;
const tabRow = document.querySelector<HTMLElement>('.tab-row')!;
const toolbarRight = document.querySelector<HTMLElement>('.toolbar-right')!;
const neoBar = $('neo-bar');

let tabs: RemoteTab[] = [];
let viewedId = '', activeId = '';
let control: Control = { controller: 'agent', yours: false, since: 0, agentBusy: false, pendingAgentCalls: 0 };
const builds = new BuildWatch(() => location.reload(), () => notify('Tandem was updated. It reloads when you hand control back.'));
let preference: 'watch' | 'agent' = 'watch';
try { if (localStorage.getItem('tandem.mode') === 'agent') preference = 'agent'; } catch { /* Optional preference. */ }
let socket: WebSocket | undefined;
let connected = false, stopped = false, reconnecting = false;
let reconnectAttempt = 0, incomingFrame = 0;
let latency: number | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let viewportTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let frame: { header: FrameHeader; image: ImageBitmap } | undefined;
let dialog: RemoteDialog | undefined;
const copies = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const pressed = new Map<string, KeyboardEvent>();
const clickCounter = new ClickCounter();
const clickCounts = new Map<number, number>();
const heldButtons = new Set<number>();
let pendingMove: PointerEvent | undefined;
let lastPointer: PointerEvent | undefined;
let moveRaf = 0, composing = false;
const mode = () => control.yours ? 'manual' : preference;
const tab = () => tabs.find(item => item.targetId === viewedId);
const canInput = () => view === 'lite' && connected && control.yours && !!tab();
function send(message: Message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message)); return true;
}
function remote(message: Message) { return canInput() && send({ ...message, targetId: viewedId }); }
function follow() { send({ t: 'follow', enabled: view === 'neo' && preference === 'watch' && !control.yours }); }
document.body.classList.toggle('desktop-mac', window.tandemDesktop?.platform === 'darwin');
function applyView() {
  document.body.classList.toggle('neo-view', view === 'neo');
  neoBar.hidden = view !== 'neo'; $('neo-window').hidden = view !== 'neo';
  if (view === 'neo') {
    // One bar: the take-control action sits beside who is driving instead of in a second row.
    neoBar.append(logo, $('connection'), toolbarRight); $('control-indicator').after($('banner-action')); neo?.start();
  } else {
    tabRow.prepend(logo); tabRow.append($('connection')); document.querySelector('.toolbar')!.append(toolbarRight);
    $('control-banner').append($('banner-action')); neo?.stop();
  }
  $('stream-setting').hidden = view !== 'neo';
  renderStream();
  $('switch-view').textContent = view === 'neo' ? 'Lite view' : 'Full browser';
}
function switchView(next: View) {
  releaseInputs();
  view = next; persistView(view, viewStorage);
  const url = new URL(location.href); url.searchParams.set('view', view); history.replaceState(null, '', url);
  // Reset the viewer socket to drop any old Lite screencast subscription.
  send({ t: 'follow', enabled: false }); connected = false; neo?.setControl(control, false);
  clearTimeout(reconnectTimer);
  const willClose = socket && socket.readyState !== WebSocket.CLOSED;
  socket?.close();
  if (!willClose && brand) scheduleReconnect();
  applyView(); render(); draw();
}

function notify(message: string, takeControl = false) {
  $('notice').replaceChildren(document.createTextNode(message));
  if (takeControl) {
    const button = document.createElement('button'); button.textContent = 'Take control';
    button.onclick = () => setMode('manual'); $('notice').append(button);
  }
  $('notice').hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5000);
}
function viewport() {
  const rect = (view === 'neo' ? $('neo-window') : canvas).getBoundingClientRect();
  return { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)), dpr: window.devicePixelRatio || 1 };
}
function draw() {
  if (view === 'neo') return;
  const { w, h, dpr } = viewport();
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#F0EEE6';
  context.fillRect(0, 0, w, h);
  if (frame) {
    const fit = fitFrame(w, h, frame.header.deviceWidth, frame.header.deviceHeight);
    context.drawImage(frame.image, fit.x, fit.y, fit.width, fit.height);
  }
  $('empty').hidden = !!frame || !!dialog;
  $('empty-title').textContent = tabs.length ? 'A moment, your page is on its way' : 'Room for your next idea';
  $('empty-description').textContent = tabs.length ? 'Waiting for the first live frame…' : control.yours ? 'Open a new tab to get started.' : `Your tabs will appear when ${brand?.agentName ?? 'the agent'} opens a page.`;
}
function selectTab(targetId: string, activate = control.yours) {
  if (view === 'neo') return;
  if (!tabs.some(item => item.targetId === targetId)) return;
  releaseInputs();
  if (viewedId !== targetId) { incomingFrame++; frame?.image.close(); frame = undefined; }
  viewedId = targetId;
  send({ t: activate && control.yours ? 'tab.activate' : 'view', targetId });
  render(); draw();
  $('tabs').querySelector<HTMLElement>(`.tab-select[data-target="${CSS.escape(targetId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderTabs() {
  const strip = $('tabs');
  const previousScroll = strip.scrollLeft;
  const focused = document.activeElement as HTMLElement | null;
  const focusTarget = focused?.dataset.target;
  const focusClose = focused?.classList.contains('tab-close');
  strip.replaceChildren();
  for (const item of tabs) {
    const wrapper = document.createElement('div'); wrapper.className = `tab${item.targetId === viewedId ? ' selected' : ''}`;
    const button = document.createElement('button'); button.className = 'tab-select'; button.role = 'tab'; button.dataset.target = item.targetId;
    button.setAttribute('aria-selected', String(item.targetId === viewedId)); button.title = `${item.title || 'New tab'}\n${item.url}`;
    button.tabIndex = item.targetId === viewedId ? 0 : -1;
    const avatar = document.createElement('span'); avatar.className = item.loading ? 'tab-avatar spinner' : 'tab-avatar';
    avatar.textContent = item.loading ? '' : (item.title || 'N').slice(0, 1).toUpperCase(); avatar.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = item.title || 'New tab';
    button.append(avatar, title);
    if (item.opener === 'agent' || (item.lastAgentActivityAt && Date.now() - item.lastAgentActivityAt < 60000)) {
      const robot = document.createElement('span'); robot.className = 'agent-badge'; robot.textContent = '🤖'; robot.title = `${brand?.agentName ?? 'Agent'} activity`; robot.setAttribute('aria-label', 'Agent tab'); button.append(robot);
    }
    button.onclick = () => selectTab(item.targetId);
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.findIndex(t => t.targetId === item.targetId);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].targetId); strip.querySelector<HTMLButtonElement>(`.tab-select[data-target="${CSS.escape(tabs[next].targetId)}"]`)?.focus();
    };
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×'; close.dataset.target = item.targetId;
    close.setAttribute('aria-label', `Close ${item.title || 'tab'}`); close.disabled = !connected || !control.yours;
    close.onclick = () => { if (control.yours) send({ t: 'tab.close', targetId: item.targetId }); };
    wrapper.append(button, close); strip.append(wrapper);
  }
  strip.scrollLeft = previousScroll;
  if (focusTarget) strip.querySelector<HTMLButtonElement>(`.${focusClose ? 'tab-close' : 'tab-select'}[data-target="${CSS.escape(focusTarget)}"]`)?.focus();
}
function render() {
  const current = tab(); const enabled = canInput(); const agent = brand?.agentName ?? 'Agent';
  document.body.classList.toggle('manual', control.yours); document.body.classList.toggle('disconnected', !connected);
  renderTabs();
  if (document.activeElement !== address) address.value = displayUrl(current?.url ?? '');
  address.readOnly = !enabled; $('view-only').hidden = enabled;
  $<HTMLButtonElement>('back').disabled = !enabled || !current?.canGoBack;
  $<HTMLButtonElement>('forward').disabled = !enabled || !current?.canGoForward;
  $<HTMLButtonElement>('reload').disabled = !enabled;
  $('reload').textContent = current?.loading ? '×' : '↻';
  $('reload').setAttribute('aria-label', current?.loading ? 'Stop loading' : 'Reload'); $('reload').title = current?.loading ? 'Stop loading' : 'Reload';
  $<HTMLButtonElement>('new-tab').disabled = !connected || !control.yours;
  $<HTMLButtonElement>('desktop-view').disabled = !connected || !control.yours;
  const pending = control.pendingAgentCalls;
  const driver = control.yours ? "You're driving" : control.controller === 'human' ? `${control.holderLabel || 'Another viewer'} is driving` : `${agent} is driving`;
  $('control-indicator').textContent = view === 'neo' && control.yours ? `${driver} · ${agent} paused${pending ? ` (${pending} waiting)` : ''}` : `${driver}${pending ? ` · ${pending} waiting` : ''}`;
  $('control-banner').hidden = view === 'neo';
  $('control-indicator').title = control.agentBusy ? 'An agent call is finishing. Already-running calls cannot be interrupted.' : driver;
  $('banner-text').textContent = control.yours ? `You're driving · ${agent} is paused${pending ? ` (${pending} waiting)` : ''}${control.agentBusy ? ' · One call is finishing' : ''}` : driver;
  $('banner-action').textContent = control.yours ? `Hand back to ${agent}` : view === 'neo' ? 'Take control · or click the page' : 'Take control';
  $<HTMLButtonElement>('banner-action').disabled = !connected;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode())); button.disabled = !connected;
  }
  renderConnection();
  canvas.setAttribute('aria-label', enabled ? 'Remote browser page. Click to focus, then type or use the keyboard.' : `${driver}. Take manual control to interact.`);
  const titled = view === 'neo' ? tabs.find(item => item.targetId === activeId) : current;
  document.title = pageTitle(titled?.title ?? '');
  neo?.setControl(control, connected);
  renderDialog();
}
function renderConnection() {
  const live = connected && (view === 'lite' || neoStatus === 'live');
  const retrying = reconnecting || view === 'neo' && neoStatus === 'reconnecting';
  $('neo-loading').hidden = view !== 'neo' || ['live', 'paused'].includes(neoStatus);
  $('neo-loading-text').textContent = retrying ? 'Reconnecting…' : 'Connecting to your browser…';
  const liveLabel = view === 'neo' ? `Live · ${neo?.transport ?? 'VNC'}` : 'Live';
  $('connection').textContent = view === 'neo' && neoStatus === 'paused' ? 'Paused' : live ? latency === undefined ? liveLabel : `${liveLabel} · ${latency} ms` : retrying ? 'Reconnecting…' : 'Connecting…';
  $('connection').classList.toggle('live', live);
}
function setMode(next: 'watch' | 'agent' | 'manual') {
  releaseInputs();
  if (next === 'manual') { if (view === 'neo') send({ t: 'follow', enabled: false }); send({ t: 'control.take' }); return; }
  preference = next;
  try { localStorage.setItem('tandem.mode', next); } catch { /* Optional preference. */ }
  if (control.yours) send({ t: 'control.release' });
  follow();
  if (next === 'watch' && activeId) selectTab(activeId, false);
  render();
}
function updateTabs(next: RemoteTab[], active: string) {
  const previousActive = activeId;
  tabs = next; activeId = active;
  if (control.yours && active !== previousActive && tabs.some(item => item.targetId === active) && active !== viewedId) selectTab(active, false);
  if (!tabs.some(item => item.targetId === viewedId)) {
    const fallback = tabs.find(item => item.targetId === activeId) ?? tabs[0];
    if (fallback) selectTab(fallback.targetId, false);
    else { viewedId = ''; incomingFrame++; frame?.image.close(); frame = undefined; }
  }
  render(); draw();
}
async function receiveFrame(buffer: ArrayBuffer) {
  try {
    const parsed = parseFrame(buffer);
    if (parsed.header.targetId !== viewedId) return;
    const ticket = ++incomingFrame;
    const bitmap = await createImageBitmap(new Blob([parsed.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
    if (ticket !== incomingFrame || parsed.header.targetId !== viewedId) { bitmap.close(); return; }
    frame?.image.close(); frame = { header: parsed.header, image: bitmap }; draw();
  } catch { notify('A page frame could not be decoded. Waiting for the next frame.'); }
}
function receive(message: Message) {
  switch (message.t) {
    case 'welcome':
      control = message.control as Control;
      builds.welcome(message.build, control.yours);
      updateTabs(message.tabs as RemoteTab[], String(message.activeTargetId ?? ''));
      if (view === 'lite' && viewedId) send({ t: 'view', targetId: viewedId });
      follow();
      break;
    case 'tabs': updateTabs(message.tabs as RemoteTab[], String(message.activeTargetId ?? '')); break;
    case 'control':
      if (control.yours && !message.yours) { pressed.clear(); pendingMove = undefined; heldButtons.clear(); }
      control = message as unknown as Control; follow(); render(); builds.control(control.yours); break;
    case 'agent.activity':
      if (view === 'lite' && mode() === 'watch' && typeof message.targetId === 'string' && tabs.some(t => t.targetId === message.targetId)) selectTab(message.targetId, false);
      break;
    case 'dialog': dialog = message as unknown as RemoteDialog; renderDialog(); break;
    case 'dialog.closed': if (dialog?.targetId === message.targetId) { dialog = undefined; remoteDialog.close(); draw(); } break;
    case 'clipboard': {
      const copy = copies.get(String(message.reqId));
      if (copy) { clearTimeout(copy.timer); copies.delete(String(message.reqId)); copy.resolve(String(message.text ?? '').slice(0, 100000)); } break;
    }
    case 'pong': latency = Math.max(0, Math.round(Date.now() - Number(message.ts))); renderConnection(); break;
    case 'error': {
      const copy = copies.get(String(message.reqId));
      if (copy) { clearTimeout(copy.timer); copies.delete(String(message.reqId)); copy.reject(new Error(String(message.message))); }
      if (message.code === 'unauthorized' || message.code === 401 || message.code === '401') location.assign('/login');
      else notify(String(message.message || message.code)); break;
    }
  }
}
async function connect() {
  if (stopped) return;
  try {
    const me = await fetch('/api/me', { cache: 'no-store' });
    if (me.status === 401) { location.assign('/login'); return; }
    if (!me.ok) throw new Error('Connection unavailable');
    if (stopped) return;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`); socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      connected = true; reconnectAttempt = 0; reconnecting = false;
      send({ t: 'hello', viewport: viewport() });
      clearInterval(pingTimer); pingTimer = setInterval(() => send({ t: 'ping', ts: Date.now() }), 15000); render();
    };
    socket.onmessage = event => {
      if (event.data instanceof ArrayBuffer) { if (view === 'lite') void receiveFrame(event.data); }
      else { try { receive(JSON.parse(event.data)); } catch { notify('Received an invalid browser update.'); } }
    };
    socket.onclose = event => {
      connected = false; clearInterval(pingTimer); pressed.clear(); pendingMove = undefined; heldButtons.clear();
      for (const [id, request] of copies) { clearTimeout(request.timer); request.reject(new Error('Browser disconnected.')); copies.delete(id); }
      if (event.code === 4401 || event.code === 401) { stopped = true; location.assign('/login'); return; }
      scheduleReconnect();
    };
    socket.onerror = () => { /* The close event owns reconnect scheduling. */ };
  } catch { scheduleReconnect(); }
}
function scheduleReconnect() {
  if (stopped) return;
  connected = false; reconnecting = true; render(); clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), Math.min(30000, 700 * 2 ** reconnectAttempt++) + Math.random() * 300);
}
function renderDialog() {
  if (!dialog || view === 'neo') { if (remoteDialog.open) remoteDialog.close(); return; }
  const wasOpen = remoteDialog.open;
  $('dialog-title').textContent = dialog.type === 'beforeunload' ? 'Leave this page?' : dialog.type === 'prompt' ? 'This page needs a response' : 'This page says';
  $('dialog-message').textContent = dialog.message; $('prompt-label').hidden = dialog.type !== 'prompt';
  const input = $<HTMLInputElement>('dialog-prompt'); if (!wasOpen) input.value = dialog.defaultPrompt ?? '';
  input.disabled = !control.yours || !connected;
  $('dialog-readonly').hidden = control.yours;
  $('dialog-take-control').hidden = control.yours;
  $<HTMLButtonElement>('dialog-take-control').disabled = !connected;
  $('dialog-readonly').textContent = `${control.controller === 'human' ? 'The controlling viewer' : brand?.agentName ?? 'The agent'} will answer this dialog. Take manual control to respond.`;
  $<HTMLButtonElement>('dialog-accept').disabled = !control.yours || !connected;
  $<HTMLButtonElement>('dialog-cancel').disabled = !control.yours || !connected;
  $('dialog-cancel').hidden = dialog.type === 'alert';
  if (!wasOpen) remoteDialog.showModal();
}
function respondDialog(accept: boolean) {
  if (dialog && control.yours && connected) send({ t: 'dialog.respond', targetId: dialog.targetId, accept, ...(dialog.type === 'prompt' ? { promptText: $<HTMLInputElement>('dialog-prompt').value } : {}) });
}
async function copySelection(cut = false) {
  if (!canInput()) return;
  const targetId = viewedId, reqId = crypto.randomUUID();
  const text = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { copies.delete(reqId); reject(new Error('Clipboard request timed out.')); }, 5000);
    copies.set(reqId, { resolve, reject, timer }); remote({ t: 'clipboard.copy', reqId });
  });
  if (window.tandemDesktop) window.tandemDesktop.writeClipboard(text); else await navigator.clipboard.writeText(text);
  if (cut && targetId === viewedId) shortcut('x');
}
function shortcut(key: string, shift = false) {
  const event = { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: false, altKey: false, shiftKey: shift };
  remote(keyMessage(event, 'down', false)); remote(keyMessage(event, 'up', false));
}
async function localEdit(command: string) {
  if (command === 'edit-select-all') { address.select(); return; }
  if (command === 'edit-copy' || command === 'edit-cut') {
    const start = address.selectionStart ?? 0, end = address.selectionEnd ?? 0;
    const selected = address.value.slice(start, end);
    if (window.tandemDesktop) window.tandemDesktop.writeClipboard(selected); else await navigator.clipboard.writeText(selected);
    if (command === 'edit-cut' && !address.readOnly) document.execCommand('delete');
  } else if (command === 'edit-paste' && !address.readOnly) {
    const value = window.tandemDesktop ? window.tandemDesktop.readClipboard() : await navigator.clipboard.readText(); document.execCommand('insertText', false, value);
  } else if (!address.readOnly) document.execCommand(command === 'edit-undo' ? 'undo' : 'redo');
}
async function remoteEdit(command: string) {
  if (!canInput()) return;
  if (command === 'edit-copy' || command === 'edit-cut') await copySelection(command === 'edit-cut');
  else if (command === 'edit-paste') {
    const text = window.tandemDesktop ? window.tandemDesktop.readClipboard() : await navigator.clipboard.readText(); remote({ t: 'input.text', text: text.slice(0, 100000) });
  } else shortcut(command === 'edit-select-all' ? 'a' : 'z', command === 'edit-redo');
}
async function showAudit() {
  if (!auditDialog.open) auditDialog.showModal(); $('audit-content').textContent = 'Loading…';
  try {
    const response = await fetch('/api/audit?limit=200');
    if (response.status === 401) { location.assign('/login'); return; }
    if (!response.ok) throw new Error('Unable to load audit log.');
    $('audit-content').textContent = JSON.stringify(await response.json(), null, 2);
  } catch { $('audit-content').textContent = 'Unable to load audit log. Please try again.'; }
}
async function logout() {
  const response = await fetch('/api/logout', { method: 'POST', headers: { 'X-Tandem': '1' } });
  if (!response.ok && response.status !== 401) throw new Error('Unable to log out. Please try again.');
  stopped = true; socket?.close(); location.assign('/login');
}
function openDesktop() { if (view === 'neo') { neo?.focus(); return; } if (connected && control.yours) window.open('/desktop/', '_blank', 'noopener,noreferrer'); }
async function command(command: string) {
  if (view === 'neo' && await neo?.command(command)) return;
  const route = commandRoute(command, document.activeElement === address);
  if (route === 'address') return localEdit(command);
  if (route === 'remote') return remoteEdit(command);
  const index = selectedTabIndex(command, tabs.findIndex(item => item.targetId === viewedId), tabs.length);
  if (index !== null) { selectTab(tabs[index].targetId); return; }
  switch (command) {
    case 'new-tab': if (connected && control.yours) send({ t: 'tab.new' }); break;
    case 'close-tab': remote({ t: 'tab.close' }); break;
    case 'focus-address': address.focus(); address.select(); break;
    case 'reload': case 'stop': case 'back': case 'forward': remote({ t: `nav.${command}` }); break;
    case 'take-control': setMode('manual'); break;
    case 'release-control': if (control.yours) setMode(preference); break;
    case 'mode-watch': setMode('watch'); break;
    case 'mode-agent': setMode('agent'); break;
    case 'mode-manual': setMode('manual'); break;
    case 'open-desktop-view': openDesktop(); break;
    case 'show-audit': await showAudit(); break;
    case 'logout': await logout(); break;
  }
}
function runCommand(name: string) { void command(name).catch(error => notify(error instanceof Error ? error.message : 'Unable to complete command.')); }
function releasePressed() { for (const event of pressed.values()) remote(keyMessage(event, 'up', mac)); pressed.clear(); }
function releaseInputs() {
  releasePressed(); pendingMove = undefined;
  const event = lastPointer;
  if (event) {
    const point = position(event, true);
    for (const button of heldButtons) if (point) remote({ t: 'input.mouse', type: 'up', ...point, button: mouseButton(button), buttons: 0, clickCount: clickCounts.get(button), modifiers: modifiers(event, mac) });
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  heldButtons.clear(); lastPointer = undefined;
}
function position(event: MouseEvent, clamp = false) { return frame?.header.targetId === viewedId ? mapPointer(event.clientX, event.clientY, canvas.getBoundingClientRect(), frame.header, clamp) : null; }
function mouse(event: PointerEvent, type: 'move' | 'down' | 'up') {
  const point = position(event, canvas.hasPointerCapture(event.pointerId)); if (!point || !canInput()) return;
  lastPointer = event;
  remote({ t: 'input.mouse', type, ...point, button: type === 'move' ? 'none' : mouseButton(event.button), buttons: event.buttons,
    clickCount: type === 'move' ? 0 : clickCounts.get(event.button) ?? 1, modifiers: modifiers(event, mac) });
}
function flushMove() { if (pendingMove) { mouse(pendingMove, 'move'); pendingMove = undefined; } }
canvas.addEventListener('pointerdown', event => {
  if (!canInput() || !position(event)) return;
  event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId); heldButtons.add(event.button);
  clickCounts.set(event.button, clickCounter.next(event.timeStamp, event.clientX, event.clientY, event.button)); flushMove(); mouse(event, 'down');
});
canvas.addEventListener('pointermove', event => {
  if (!canInput() || document.activeElement !== canvas) return;
  pendingMove = event; if (!moveRaf) moveRaf = requestAnimationFrame(() => { moveRaf = 0; flushMove(); });
});
canvas.addEventListener('pointerup', event => {
  if (!canInput() || document.activeElement !== canvas) return;
  event.preventDefault(); flushMove(); mouse(event, 'up'); heldButtons.delete(event.button);
  if (event.buttons === 0 && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener('pointercancel', event => {
  for (const button of heldButtons) {
    const point = position(event, true);
    if (point) remote({ t: 'input.mouse', type: 'up', ...point, button: mouseButton(button), buttons: 0, clickCount: clickCounts.get(button), modifiers: modifiers(event, mac) });
  }
  heldButtons.clear();
});
canvas.addEventListener('wheel', event => {
  if (!canInput() || document.activeElement !== canvas) return;
  event.preventDefault(); const point = position(event); if (!point) return;
  remote({ t: 'input.mouse', type: 'wheel', ...point, button: 'none', buttons: event.buttons,
    deltaX: wheelDelta(event.deltaX, event.deltaMode, frame!.header.deviceWidth), deltaY: wheelDelta(event.deltaY, event.deltaMode, frame!.header.deviceHeight), modifiers: modifiers(event, mac) });
}, { passive: false });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('keydown', event => {
  if (!canInput() || document.activeElement !== canvas || event.isComposing || composing || event.keyCode === 229) return;
  const shortcutKey = (event.ctrlKey || (mac && event.metaKey)) && !event.altKey;
  if (shortcutKey && event.key.toLowerCase() === 'v') return;
  event.preventDefault();
  if (shortcutKey && ['c', 'x'].includes(event.key.toLowerCase())) { if (!event.repeat) runCommand(event.key.toLowerCase() === 'x' ? 'edit-cut' : 'edit-copy'); return; }
  pressed.set(event.code, event); remote(keyMessage(event, 'down', mac));
});
canvas.addEventListener('keyup', event => {
  if (!canInput() || document.activeElement !== canvas || composing || event.isComposing) return;
  event.preventDefault(); if (!pressed.has(event.code)) return;
  pressed.delete(event.code); remote(keyMessage(event, 'up', mac));
});
canvas.addEventListener('paste', event => {
  if (!canInput() || document.activeElement !== canvas) return;
  event.preventDefault(); remote({ t: 'input.text', text: (event.clipboardData?.getData('text/plain') ?? '').slice(0, 100000) });
});
canvas.addEventListener('beforeinput', event => { if (!composing) event.preventDefault(); });
canvas.addEventListener('input', () => { if (!composing) canvas.textContent = ''; });
canvas.addEventListener('compositionstart', () => { composing = true; });
canvas.addEventListener('compositionend', event => { composing = false; if (canInput() && document.activeElement === canvas && event.data) remote({ t: 'input.text', text: event.data.slice(0, 100000) }); });
canvas.addEventListener('blur', releaseInputs); window.addEventListener('blur', releaseInputs);
$('address-form').addEventListener('submit', event => { event.preventDefault(); if (remote({ t: 'nav.go', url: address.value })) canvas.focus(); });
address.addEventListener('focus', () => address.select()); address.addEventListener('blur', () => { address.value = displayUrl(tab()?.url ?? ''); });
$('new-tab').onclick = () => runCommand('new-tab'); $('back').onclick = () => runCommand('back'); $('forward').onclick = () => runCommand('forward');
$('reload').onclick = () => runCommand(tab()?.loading ? 'stop' : 'reload'); $('desktop-view').onclick = openDesktop;
$('banner-action').onclick = () => setMode(control.yours ? preference : 'manual');
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) button.onclick = () => setMode(button.dataset.mode as 'watch' | 'agent' | 'manual');
$('menu-button').onclick = () => { const menu = $('menu'); menu.hidden = !menu.hidden; $('menu-button').setAttribute('aria-expanded', String(!menu.hidden)); if (!menu.hidden) $('switch-view').focus(); };
function renderStream() {
  $('stream-smooth').setAttribute('aria-pressed', String(stream === 'smooth'));
  $('stream-sharp').setAttribute('aria-pressed', String(stream === 'sharp'));
}
function setStream(next: StreamPreference) {
  closeMenu();
  if (next === stream) return;
  stream = next; persistStream(stream, viewStorage); renderStream(); neo?.setStream(stream);
}
$('stream-smooth').onclick = () => setStream('smooth');
$('stream-sharp').onclick = () => setStream('sharp');
function closeMenu() { $('menu').hidden = true; $('menu-button').setAttribute('aria-expanded', 'false'); }
document.addEventListener('click', event => { if (!(event.target as HTMLElement).closest('.menu-wrap')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('menu').hidden) { closeMenu(); $('menu-button').focus(); } });
$('switch-view').onclick = () => { closeMenu(); switchView(view === 'neo' ? 'lite' : 'neo'); };
$('show-audit').onclick = () => { closeMenu(); runCommand('show-audit'); }; $('logout').onclick = () => runCommand('logout'); $('audit-close').onclick = () => auditDialog.close();
$('dialog-form').addEventListener('submit', event => { event.preventDefault(); respondDialog(true); }); $('dialog-cancel').onclick = () => respondDialog(false);
$('dialog-take-control').onclick = () => setMode('manual');
remoteDialog.addEventListener('cancel', event => { event.preventDefault(); if (control.yours) respondDialog(false); });
const unsubscribe = window.tandemDesktop?.onCommand(runCommand);
if (window.tandemDesktop) { $('settings').hidden = false; $('settings').onclick = () => window.tandemDesktop!.openSettings(); }
function resized() { draw(); clearTimeout(viewportTimer); viewportTimer = setTimeout(() => send({ t: 'viewport', ...viewport() }), 150); }
new ResizeObserver(resized).observe(canvas); window.addEventListener('resize', resized);
window.addEventListener('pagehide', () => { stopped = true; send({ t: 'follow', enabled: false }); neo?.stop(); releaseInputs(); unsubscribe?.(); clearInterval(pingTimer); clearTimeout(reconnectTimer); socket?.close(); frame?.image.close(); });
async function start() { try { brand = await loadBrand();
  neo = new NeoView($('neo-window'), mac, brand.colors.background || '#FAF9F5', status => { neoStatus = status; renderConnection(); }, notify, () => setMode('manual'), send, stream);
  applyView(); render(); draw(); await connect(); } catch (error) { notify(error instanceof Error ? error.message : 'Unable to start browser.'); } }
applyView();
void start();
