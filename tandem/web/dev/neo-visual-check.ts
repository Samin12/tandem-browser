// Real-engine, headless-only acceptance. Supply credentials through the environment.
// See README for the isolated compose stack and cleanup commands.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
const base = process.env.TANDEM_URL ?? 'http://127.0.0.1:18790';
const password = process.env.TANDEM_PASSWORD;
if (!password) throw new Error('Set TANDEM_PASSWORD to the disposable stack password.');
const out = resolve(import.meta.dir, 'screenshots/neo');
await mkdir(out, { recursive: true });
const profile = await mkdtemp(resolve(homedir(), '.cache/tandem-neo-check-'));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T>, label: string, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(150); }
  throw new Error(`Timed out: ${label}`);
}
const checks: string[] = [], errors: string[] = [], logs: unknown[] = [];
function check(value: unknown, label: string) { if (!value) throw new Error(label); checks.push(label); console.log(`PASS ${label}`); }
const chrome = Bun.spawn([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
let ws: WebSocket | undefined;
try {
  const port = await until(async () => { try { return (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return ''; } }, 'Chrome');
  const page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()) as any[]).find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((r, reject) => { ws!.onopen = () => r(); ws!.onerror = () => reject(new Error('CDP failed')); });
  let id = 0;
  const pending = new Map<number, { resolve: (r: any) => void; reject: (e: unknown) => void }>();
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data));
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a: any) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); }
  };
  const cdp = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); ws!.send(JSON.stringify({ id, method, params }));
  });
  const js = async (expression: string) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed');
    return result.result.value;
  };
  const wait = (expression: string, label: string) => until(() => js(expression), label);
  const click = (selector: string) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const shot = async (name: string) => {
    const result = await cdp('Page.captureScreenshot', { format: 'png' });
    await Bun.write(resolve(out, name), Buffer.from(result.data, 'base64'));
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.viewerMessages=[];window.vncSockets=[];window.keyStrokes=[];window.pastes=[];window.viewOnlyStates=[];
    const NativeSocket=window.WebSocket;
    window.WebSocket=new Proxy(NativeSocket,{construct(Target,args){
      const socket=Reflect.construct(Target,args);
      if(String(args[0]).endsWith('/ws'))window.viewerSocket=socket;
      if(String(args[0]).endsWith('/desktop/websockify')){window.vncSockets.push(socket);socket.addEventListener('close',e=>console.log('VNC closed',e.code,e.reason))}
      const send=socket.send;socket.send=function(data){if(this.url.endsWith('/ws')&&typeof data==='string')window.viewerMessages.push(JSON.parse(data));return send.call(this,data)};
      return socket;
    }});
    window.tandemDesktop={isDesktop:true,platform:'darwin',version:'acceptance',onCommand(cb){window.desktopCommand=cb;return()=>{}},writeClipboard(text){window.remoteCopied=text},readClipboard(){return window.clipboardText ?? 'Tandem clipboard acceptance'},openSettings(){window.settingsOpened=true}};
  ` });
  await cdp('Page.navigate', { url: `${base}/login` });
  await wait("!!document.querySelector('#login-submit') && !document.querySelector('#login-submit').disabled", 'login');
  await js(`document.querySelector('#password').value=${JSON.stringify(password)};document.querySelector('#login-form').requestSubmit()`);
  await wait("location.pathname==='/' && document.body.classList.contains('neo-view')", 'default Neo view');
  try { await wait("document.querySelector('#connection').textContent.startsWith('Live') && document.querySelector('#neo-window canvas')?.width>500", 'real Neo VNC framebuffer'); } catch(error) { await shot('failure.png'); console.log(JSON.stringify({ errors, logs, state:await js("({text:document.body.innerText,canvas:document.querySelector('#neo-window canvas')?.outerHTML,messages:viewerMessages})") },null,2));throw error; }
  check(true, 'default Neo connects to the real VNC engine');
  await js(`(async()=>{
    const {default:RFB}=await import('/desktop/core/rfb.js');
    const send=RFB.prototype.sendKey;RFB.prototype.sendKey=function(...args){window.keyStrokes.push(args);return send.apply(this,args)};
    const paste=RFB.prototype.clipboardPasteFrom;RFB.prototype.clipboardPasteFrom=function(text){window.pastes.push(text);return paste.call(this,text)};
    const d=Object.getOwnPropertyDescriptor(RFB.prototype,'viewOnly');Object.defineProperty(RFB.prototype,'viewOnly',{...d,set(value){window.viewOnlyStates.push(value);window.realRFB=this;d.set.call(this,value)}});
  })()`);
  check(await js("!viewerMessages.some(m=>m.t==='view') && viewerMessages.some(m=>m.t==='follow'&&m.enabled)"), 'Neo follows Watch without subscribing to screencasts');
  check(await js("document.querySelector('#neo-bar').getBoundingClientRect().height===52"), 'Tandem bar is 52px');
  check(await js("document.querySelector('#neo-window').getBoundingClientRect().width===1440 && document.documentElement.scrollWidth===1440"), 'Neo spans the viewport without margins or overflow');
  await click('[data-mode=manual]');
  await wait("document.body.classList.contains('manual') && window.realRFB?.viewOnly===false", 'manual acknowledgment');
  check(true, 'server control acknowledgment enables VNC input');
  // A fresh tab picks up the Neo dashboard extension installed during first boot.
  const bootTabs = await js("document.querySelectorAll('#tabs [role=tab]').length");
  await js("desktopCommand('new-tab')");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${bootTabs + 1}`, 'fresh Neo dashboard tab');
  await js("desktopCommand('prev-tab');desktopCommand('close-tab')");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${bootTabs}`, 'remove first-boot tab');
  await delay(6000);
  const distinct = await js("(()=>{const c=document.querySelector('#neo-window canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,s=new Set;for(let i=0;i<d.length;i+=400)s.add(d[i]+','+d[i+1]+','+d[i+2]);return s.size})()");
  check(distinct > 20, 'VNC contains a rendered real window, not an empty canvas');
  await shot('manual.png');
  check(await js("document.title.endsWith('Tandem Browser') && document.querySelector('#control-indicator').textContent.includes('Hermes paused')"), 'window title and paused agent indicator');
  const initialTabs = await js("document.querySelectorAll('#tabs [role=tab]').length");
  await js("desktopCommand('new-tab')");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${initialTabs + 1}`, 'native new-tab via VNC');
  check(true, 'desktop new-tab changes the real engine tab count');
  // Chromium doesn't restore an untouched blank new-tab page. Visit a page first.
  await js("window.clipboardText='https://example.com';desktopCommand('focus-address');desktopCommand('edit-paste')");
  await delay(200);
  await js("realRFB.sendKey(0xff0d,'Enter',true);realRFB.sendKey(0xff0d,'Enter',false);window.clipboardText=undefined");
  await wait("[...document.querySelectorAll('#tabs [role=tab]')].some(t=>t.title.includes('https://example.com'))", 'remote page navigation');
  await js("desktopCommand('close-tab')");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${initialTabs}`, 'native close-tab via VNC');
  check(true, 'desktop close-tab changes the real engine tab count');
  await js("document.querySelector('#neo-window canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'T',code:'KeyT',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}))");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${initialTabs + 1}`, 'Mac reopen tab via Control Shift T');
  check(await js("keyStrokes.slice(-6).map(x=>x[0]).join(',')==='65507,65505,116,116,65505,65507'"), 'Mac Command Shift T reaches the real engine as balanced Control Shift T');
  await js("desktopCommand('focus-address');desktopCommand('edit-paste')");
  await wait("pastes.includes('Tandem clipboard acceptance') && keyStrokes.slice(-4).map(x=>x[0]).join(',')==='65507,118,118,65507'", 'desktop clipboard paste');
  await delay(200);
  check(await js("keyStrokes.slice(-4).map(x=>x[0]).join(',')==='65507,118,118,65507'"), 'desktop paste pushes clipboard before sending Control V');
  // Change the selected text remotely so noVNC's clipboard echo suppression
  // cannot satisfy (or suppress) the remote-to-local copy assertion.
  await js("realRFB.sendKey(0xff50,'Home',true);realRFB.sendKey(0xff50,'Home',false);realRFB.sendKey(114,'KeyR',true);realRFB.sendKey(114,'KeyR',false);desktopCommand('edit-select-all');desktopCommand('edit-copy')");
  await wait("window.remoteCopied==='rTandem clipboard acceptance'", 'remote clipboard copy');
  check(true, 'real VNC clipboard event writes through the desktop bridge');
  await js("desktopCommand('stop');desktopCommand('close-tab')");
  await wait(`document.querySelectorAll('#tabs [role=tab]').length===${initialTabs}`, 'cleanup shortcut test tab');
  await click('[data-mode=agent]');
  await wait("!document.body.classList.contains('manual') && window.realRFB?.viewOnly===true", 'viewOnly on release');
  const connectionCount = await js('vncSockets.length');
  await wait("(()=>{const c=document.querySelector('#neo-window canvas'),r=document.querySelector('#neo-window').getBoundingClientRect();return c.width===r.width && c.height===r.height})()", 'view-only framebuffer resized to available space');
  await delay(1000); await shot('agent.png');
  check(true, 'view-only Neo resizes edge to edge without letterboxing');
  check(await js(`vncSockets.length===${connectionCount} && vncSockets.at(-1).readyState===1`), 'agent viewing stays on the same live VNC connection after release');
  check(await js("viewerMessages.filter(m=>m.t==='follow').at(-1).enabled===false"), 'Agent mode disables follow');
  const before = await js('keyStrokes.length');
  await js("desktopCommand('new-tab')");
  check(await js(`keyStrokes.length===${before} && document.querySelector('#notice').textContent.includes('Take control first')`), 'commands without control send no keys and explain takeover');
  await js("document.querySelector('#neo-window canvas').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))");
  check(await js("document.querySelector('#notice').textContent.includes('Take control to use the browser') && !!document.querySelector('#notice button') && !document.body.classList.contains('manual')"), 'view-only click offers explicit takeover without taking control');
  await click('[data-mode=watch]');
  check(await js("viewerMessages.filter(m=>m.t==='follow').at(-1).enabled===true"), 'Watch mode enables follow');
  await js("document.querySelector('#notice').hidden=true"); await shot('watch.png');
  await js("vncSockets.at(-1).close()");
  await wait("document.querySelector('#connection').textContent==='Reconnecting…'", 'VNC reconnect status');
  await wait(`vncSockets.length>${connectionCount} && document.querySelector('#connection').textContent.startsWith('Live')`, 'VNC reconnect');
  check(true, 'VNC reconnects with visible backoff state');
  await js("viewerSocket.close()");
  await wait("document.querySelector('#connection').textContent==='Reconnecting…'", 'viewer socket reconnect status');
  await click('#switch-view');
  await wait("!document.body.classList.contains('neo-view') && document.querySelector('#empty').hidden && document.querySelector('#connection').textContent.startsWith('Live')", 'Lite screencast');
  check(await js("localStorage.getItem('tandem.view')==='lite' && viewerMessages.filter(m=>m.t==='follow').at(-1).enabled===false && viewerMessages.some(m=>m.t==='view')"), 'switching to Lite during a viewer disconnect reconnects, persists, disables follow and receives screencasts');
  await shot('lite.png');
  await cdp('Page.navigate', { url: `${base}/` });
  await wait("document.querySelector('#connection')?.textContent.startsWith('Live')", 'saved Lite on revisit');
  check(await js("!document.body.classList.contains('neo-view')"), 'saved Lite survives revisiting the default URL');
  await cdp('Page.navigate', { url: `${base}/?view=neo` });
  await wait("document.body.classList.contains('neo-view') && document.querySelector('#connection')?.textContent.startsWith('Live')", 'explicit Neo');
  check(await js("localStorage.getItem('tandem.view')==='neo' && !viewerMessages.some(m=>m.t==='view')"), 'explicit Neo overrides preference and has no screencast subscription');
  await cdp('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:false });
  await delay(1000); await shot('narrow.png');
  check(await js("document.documentElement.scrollWidth===390"), '390px Neo bar has no horizontal overflow');
  check(!errors.length, `no browser runtime exceptions (${errors.length})`);
  await Bun.write(resolve(out, 'results.json'), JSON.stringify({ checks, runtimeErrors: errors }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, screenshots: out, runtimeErrors: errors }, null, 2));
} finally {
  ws?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true });
}
