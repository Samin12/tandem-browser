import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const screenshots = process.env.TANDEM_SCREENSHOTS ?? resolve(import.meta.dir, 'screenshots');
await mkdir(screenshots, { recursive: true });
await mkdir(resolve(homedir(), '.cache'), { recursive: true });
const profile = await mkdtemp(resolve(homedir(), '.cache/tandem-web-check-'));
const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
const port = probe.port!; probe.stop(true);
const origin = `http://127.0.0.1:${port}`;
const password = crypto.randomUUID();
const totp = process.argv.includes('--totp');
const mock = Bun.spawn(['bun', 'dev/mock-server.ts'], { cwd: root, env: { ...process.env, PORT: String(port), TANDEM_DEV_PASSWORD: password, TANDEM_DEV_TOTP: totp ? '1' : '0' }, stdout: 'ignore', stderr: 'pipe' });
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
const checks: string[] = [], errors: string[] = [], captures: string[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(fn: () => Promise<T>, description: string, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch { /* Not ready. */ } await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
function check(value: unknown, description: string) { if (!value) throw new Error(description); checks.push(description); }
try {
  await until(async () => (await fetch(`${origin}/api/health`)).ok, 'mock startup');
  chrome = Bun.spawn([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
  ], { stdout: 'ignore', stderr: 'ignore' });
  const debug = await until(async () => {
    const text = await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8');
    return text.split('\n')[0];
  }, 'headless Chrome startup');
  const targets = await fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find(t => t.type === 'page')!;
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error('CDP connection failed')); });
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (value: unknown) => void }>();
  ws.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description ?? ''));
    const call = pending.get(message.id);
    if (call) { pending.delete(message.id); message.error ? call.reject(message.error) : call.resolve(message.result); }
  };
  const cdp = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params })); });
  const js = async (expression: string) => {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? 'Evaluation failed');
    return response.result.value;
  };
  const waitFor = (expression: string, label: string) => until(() => js(expression), label);
  const shot = async (name: string) => { captures.push(resolve(screenshots, name)); const image = await cdp('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(screenshots, name), Buffer.from(image.data, 'base64')); };
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const messages = () => js("fetch('/api/mock/messages').then(r=>r.json())") as Promise<Record<string, any>[]>;
  const post = (path: string, body = {}) => js(`fetch(${JSON.stringify(path)},{method:'POST',headers:{'X-Tandem':'1','Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json())`);
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // Exercise the native preload bridge without installing or launching Electron.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('tandem.view','lite');window.tandemDesktop={isDesktop:true,platform:'darwin',version:'test',onCommand(cb){window.desktopCommand=cb;return()=>{}},writeClipboard(text){window.copiedText=text},readClipboard(){return 'Pasted from desktop'},openSettings(){window.settingsOpened=true}}` });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp('Page.navigate', { url: origin });
  await waitFor("location.pathname==='/login' && !document.querySelector('#login-submit')?.disabled", 'login config');
  check(await js("document.querySelector('#totp-field').hidden") === !totp, 'TOTP field matches auth-config');
  if (totp) await js("document.querySelector('#totp').value='123456'");
  check(await js("getComputedStyle(document.body).backgroundImage==='none' && getComputedStyle(document.body).backgroundColor==='rgb(247, 250, 253)'"), 'login has a flat cloud-blue background');
  check(await js("getComputedStyle(document.querySelector('#login-submit')).backgroundColor==='rgb(43, 120, 202)' && getComputedStyle(document.querySelector('#login-submit')).color==='rgb(255, 255, 255)'"), 'primary button uses accessible blue with white text (4.52:1)');
  await shot(totp ? 'login-totp.png' : 'login.png');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await shot('login-dark.png');
  check(await js("getComputedStyle(document.documentElement).getPropertyValue('--background').trim()==='#0F1720'"), 'login uses dark theme despite runtime branding');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await shot('login-narrow-dark.png');
  check(await js("document.documentElement.scrollWidth===innerWidth"), '390px login has no horizontal overflow');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await js("document.querySelector('#password').value='wrong-password';document.querySelector('#login-form').requestSubmit()");
  await waitFor("document.querySelector('#login-error').textContent.includes('Incorrect password')", 'invalid credentials displayed');
  check(await js("!document.querySelector('#login-submit').disabled"), 'Invalid credentials allow retry');
  if (totp) {
    await js(`document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#totp').value='000000';document.querySelector('#login-form').requestSubmit()`);
    await waitFor("document.querySelector('#login-error').textContent.includes('Incorrect password')", 'invalid TOTP displayed');
    check(await js("location.pathname==='/login'"), 'Invalid TOTP rejected with same credential error');
    await js("document.querySelector('#totp').value='123456'");
  }
  await js(`document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()`);
  await waitFor("location.pathname==='/' && document.querySelector('#connection')?.textContent.startsWith('Live') && document.querySelector('#empty')?.hidden", 'authenticated live frame');
  check(await js("document.title.endsWith(' — Tandem')"), 'runtime product name and tab title');
  await click('[data-mode="agent"]'); await shot('agent.png');
  check(await js("getComputedStyle(document.querySelector('#control-indicator')).color==='rgb(109, 91, 208)'"), 'agent control indicator uses violet');
  check(await js("document.querySelector('#address').readOnly && document.querySelector('#desktop-view').disabled"), 'Agent mode blocks address and desktop controls');
  const before = (await messages()).length;
  await js("let c=document.querySelector('#page');c.focus();c.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',bubbles:true}));c.dispatchEvent(new WheelEvent('wheel',{deltaY:10,bubbles:true,cancelable:true}))");
  await delay(100);
  check(!(await messages()).slice(before).some(m => m.t.startsWith('input.')), 'Agent mode sends no pointer/key input');
  await click('.tab-select[data-target="tab-3"]');
  check((await messages()).some(m=>m.t==='view' && m.targetId==='tab-3'), 'Agent tab selection sends view');
  await delay(4900);
  check(await js("document.querySelector('.tab-select[aria-selected=true]').dataset.target==='tab-3'"), 'Agent mode stays on selected tab across activity');
  await click('[data-mode="watch"]');
  await waitFor("document.querySelector('.tab-select[aria-selected=true]').dataset.target!=='tab-3'", 'Watch follows agent tab');
  await click('[data-mode="manual"]');
  await waitFor("document.body.classList.contains('manual')", 'Manual control acknowledgement');
  await shot('manual.png');
  check(await js("getComputedStyle(document.querySelector('#control-indicator')).color==='rgb(47, 128, 214)'"), 'manual control indicator uses human blue');
  check(await js("!document.querySelector('#address').readOnly && !document.querySelector('#desktop-view').disabled && document.querySelector('#banner-text').textContent.includes('2 waiting')"), 'Manual control enables navigation and shows waiting agent calls');
  await js("desktopCommand('focus-address');desktopCommand('edit-select-all');desktopCommand('edit-copy')"); await delay(100);
  check(await js("copiedText.startsWith('https://')"), 'Desktop copy routes to focused address field');
  await js("desktopCommand('edit-paste')");
  check(await js("document.querySelector('#address').value==='Pasted from desktop'"), 'Desktop paste edits address locally');
  await js("desktopCommand('edit-undo')");
  check(await js("document.querySelector('#address').value.startsWith('https://')"), 'Address undo restores prior URL');
  await js("document.querySelector('#page').focus();desktopCommand('edit-copy')");
  await waitFor("window.copiedText==='A selection from the shared browser'", 'remote copy reply');
  await js("desktopCommand('edit-cut');desktopCommand('edit-paste');desktopCommand('edit-select-all');desktopCommand('edit-undo');desktopCommand('edit-redo')");
  await delay(200);
  let sent = await messages();
  check(sent.some(m=>m.t==='input.text') && sent.some(m=>m.t==='input.key' && m.key==='x' && m.modifiers===2) && sent.some(m=>m.t==='input.key' && m.key==='z' && m.modifiers===10), 'Remote edit commands send copy/cut/paste and Linux shortcuts');
  const box = await js("(()=>{let r=document.querySelector('#page').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x:box.x,y:box.y,button:'left',buttons:1,clickCount:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:box.x,y:box.y,button:'left',buttons:0,clickCount:1 });
  await cdp('Input.dispatchKeyEvent', { type:'keyDown',key:'A',code:'KeyA',windowsVirtualKeyCode:65,text:'A',modifiers:8 });
  await cdp('Input.dispatchKeyEvent', { type:'keyUp',key:'A',code:'KeyA',windowsVirtualKeyCode:65,modifiers:8 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseWheel',x:box.x,y:box.y,deltaX:0,deltaY:80 });
  await js("let p=document.querySelector('#page');p.dispatchEvent(new CompositionEvent('compositionstart'));p.dispatchEvent(new CompositionEvent('compositionend',{data:'日本語'}));let e=new Event('paste',{cancelable:true});Object.defineProperty(e,'clipboardData',{value:{getData:()=> 'Pasted text'}});p.dispatchEvent(e)");
  await delay(150); sent = await messages();
  const down = [...sent].reverse().find(m=>m.t==='input.mouse' && m.type==='down');
  check(down && Math.abs(down.x-800)<1 && Math.abs(down.y-456.5)<1 && down.button==='left' && down.buttons===1, 'Pointer center maps to remote CSS pixels');
  check(sent.some(m=>m.t==='input.mouse' && m.type==='wheel' && m.deltaY===80), 'Focused wheel input reaches remote');
  check(sent.some(m=>m.t==='input.key' && m.key==='A' && m.keyCode===65 && m.modifiers===8), 'Focused keyboard input reaches remote');
  check(sent.filter(m=>m.t==='input.text').length>=3, 'Paste and IME send input.text');
  await js("desktopCommand('new-tab')");
  await waitFor("document.querySelector('.tab-select[aria-selected=true]')?.dataset.target==='tab-4'", 'new tab is viewed');
  await js("desktopCommand('close-tab')");
  await waitFor("document.querySelectorAll('.tab-select').length===3", 'tab close');
  await post('/api/mock/dialog', {type:'prompt'});
  await waitFor("document.querySelector('#remote-dialog').open", 'prompt dialog');
  await js("document.querySelector('#dialog-prompt').value='Accepted';document.querySelector('#dialog-form').requestSubmit()");
  await waitFor("!document.querySelector('#remote-dialog').open", 'dialog closed by server');
  check((await messages()).some(m=>m.t==='dialog.respond' && m.accept===true), 'Dialog response uses protocol');
  await js("desktopCommand('mode-agent')");
  await waitFor("!document.body.classList.contains('manual')", 'release acknowledgement');
  await post('/api/mock/dialog', {type:'confirm'});
  await waitFor("document.querySelector('#remote-dialog').open", 'read-only dialog');
  check(await js("document.querySelector('#dialog-accept').disabled && !document.querySelector('#dialog-take-control').hidden"), 'Read-only dialog offers manual takeover');
  await click('#dialog-take-control'); await waitFor("!document.querySelector('#dialog-accept').disabled", 'dialog takeover');
  await click('#dialog-cancel'); await waitFor("!document.querySelector('#remote-dialog').open", 'cancel dialog');
  await post('/api/mock/disconnect');
  await waitFor("document.querySelector('#connection').textContent==='Reconnecting…'", 'reconnecting state');
  check(await js("document.querySelectorAll('.tab-select').length===3 && document.querySelector('#empty').hidden"), 'Reconnect preserves tab list and last frame');
  await waitFor("document.querySelector('#connection').textContent.startsWith('Live')", 'reconnected');
  await js("desktopCommand('show-audit')");
  await waitFor("document.querySelector('#audit-content').textContent.includes('control.take')", 'audit loaded'); await click('#audit-close');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:false});
  await delay(400); await shot('narrow.png');
  check(await js("document.documentElement.scrollWidth===innerWidth"), '390px toolbar has no horizontal overflow');
  const viewportMessages = (await messages()).filter(m=>m.t==='viewport');
  check(viewportMessages.some(m=>m.dpr===2 && m.w===390), 'Resize sends CSS viewport and DPR');
  // Full browser chrome can be checked against the mock, which intentionally has no VNC engine.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#menu-button'); await click('#switch-view');
  await waitFor("document.body.classList.contains('neo-view')", 'Full browser menu selection');
  check(await js("document.querySelector('.brand-mark img').getAttribute('src')==='/assets/mark.svg' && document.querySelector('.brand-mark').textContent==='Tandem'"), 'viewer uses transparent brand mark and Tandem wordmark');
  check(await js("document.querySelector('#neo-window').getAttribute('aria-label')==='Browser window'"), 'browser window has product-neutral accessible label');
  await click('#menu-button'); await shot('viewer-full-light.png');
  check(await js("getComputedStyle(document.querySelector('#neo-loading')).backgroundImage==='none' && getComputedStyle(document.querySelector('#empty')).backgroundImage==='none'"), 'connecting and empty states have flat backgrounds');
  check(await js("document.querySelector('#stream-smooth').getAttribute('aria-pressed')==='true'"), 'Smooth is the default stream');
  await click('#stream-sharp');
  check(await js("localStorage.getItem('tandem.stream')==='sharp' && document.querySelector('#stream-sharp').getAttribute('aria-pressed')==='true'"), 'Sharp selection is persisted and reflected in the menu');
  await cdp('Page.navigate', { url: `${origin}/?view=neo` });
  await waitFor("document.querySelector('#stream-sharp')?.getAttribute('aria-pressed')==='true'", 'Sharp preference survives a reload');
  check(await js("localStorage.getItem('tandem.stream')==='sharp'"), 'Sharp preference survives a page reload');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await click('#menu-button'); await shot('viewer-full-dark.png');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await js("document.body.classList.remove('desktop-mac')");
  await shot('viewer-full-narrow-dark.png');
  check(await js("document.documentElement.scrollWidth===innerWidth && document.querySelector('#menu-button').getBoundingClientRect().right<=innerWidth"), '390px Full browser controls fit the screen');
  await click('#stream-smooth');
  check(await js("localStorage.getItem('tandem.stream')==='smooth' && document.querySelector('#stream-smooth').getAttribute('aria-pressed')==='true'"), 'Smooth can be restored');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await js("desktopCommand('logout')"); await waitFor("location.pathname==='/login'", 'logout redirect');
  for (let attempt=0;attempt<6;attempt++) {
    if(totp) await js("document.querySelector('#totp').value='123456'");
    await js("document.querySelector('#password').value='wrong-password';document.querySelector('#login-form').requestSubmit()");
    await waitFor("document.querySelector('#login-error').textContent.length>0", 'login failure response');
    if(attempt<5) await waitFor("!document.querySelector('#login-submit').disabled", 'retry available');
  }
  check(await js("document.querySelector('#login-submit').disabled && document.querySelector('#login-error').textContent.includes('Too many attempts')"), 'Rate limit disables retry and displays retry time');
  check(errors.length===0, `No browser runtime exceptions (${errors.length})`);
  console.log(JSON.stringify({ totp, checks, runtimeErrors:errors, screenshots:captures },null,2));
} finally {
  ws?.close(); chrome?.kill(); mock.kill();
  if (chrome) await chrome.exited;
  await mock.exited; await rm(profile,{recursive:true,force:true});
}
