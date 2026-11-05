// Headless-only real-stack acceptance. Run in the engine network namespace; see README.
import { chromium } from '/work/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:8790', out = '/out';
if (!process.env.TANDEM_PASSWORD) throw new Error('Set the disposable stack TANDEM_PASSWORD');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); console.log('PASS', name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36' });
await context.addInitScript(() => {
  window.viewerMessages = []; window.signalMessages = []; window.packets = []; window.peers = [];
  window.tandemDesktop = { isDesktop: true, platform: 'darwin', version: 'test', onCommand(cb) { window.desktopCommand = cb; return () => {}; },
    writeClipboard(text) { window.remoteCopied = text; }, readClipboard() { return window.localClipboard || ''; }, openSettings() {} };
  const Socket = window.WebSocket;
  window.WebSocket = new Proxy(Socket, { construct(Target, args) {
    const socket = Reflect.construct(Target, args), send = socket.send;
    socket.send = function(data) {
      if (this.url.endsWith('/neko/api/ws') && typeof data === 'string') window.signalMessages.push(JSON.parse(data));
      else if (this.url.endsWith('/ws') && typeof data === 'string') window.viewerMessages.push(JSON.parse(data));
      return send.call(this, data);
    };
    return socket;
  } });
  const Peer = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Peer, { construct(Target, args) {
    const pc = Reflect.construct(Target, args); window.peers.push(pc);
    pc.addEventListener('datachannel', e => {
      const send = e.channel.send;
      e.channel.send = function(data) { window.packets.push([...new Uint8Array(data)]); return send.call(this, data); };
    }); return pc;
  } });
});
const page = await context.newPage();
page.on('pageerror', e => { errors.push(e.message); console.log('PAGEERROR', e.message); });
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
const wait = async (fn, name, timeout = 30000) => {
  try { await page.waitForFunction(fn, null, { timeout }); }
  catch (e) { console.log('STATE', await page.evaluate(() => ({ text: document.body.innerText, messages: window.viewerMessages, signal: window.signalMessages, copied: window.remoteCopied, packets: window.packets.slice(-80), video: document.querySelector('video')?.outerHTML }))); throw new Error(name, { cause: e }); }
};
const countTabs = async () => (await fetch('http://127.0.0.1:9110/json/list').then(r => r.json())).filter(t => t.type === 'page').length;
let remote;
try {
  await page.goto(base + '/login');
  await page.locator('#password').fill(process.env.TANDEM_PASSWORD);
  await page.locator('#login-submit').click();
  await wait(() => document.querySelector('#connection')?.textContent.includes('Live · WebRTC'), 'gateway WebRTC video');
  check(await page.evaluate(() => document.querySelector('video').currentTime > 0), 'decoded WebRTC video through authenticated gateway');
  await wait(() => { const v = document.querySelector('video'); return v.videoWidth === 2880 && v.videoHeight === 1724; }, 'Retina screen size');
  check(await page.evaluate(() => window.viewerMessages.some(m => m.t === 'screen' && m.w === 2880 && m.h === 1724)), 'screen message CSS × displayScale, even pixels');
  check(await page.evaluate(() => viewerMessages.some(m => m.t === 'follow' && m.enabled)), 'Watch enables Follow');
  await page.locator('[data-mode=agent]').click(); await delay(300);
  await page.screenshot({ path: out + '/agent.png' });
  check(await page.evaluate(() => !viewerMessages.filter(m => m.t === 'follow').at(-1).enabled), 'Agent disables Follow');
  await page.evaluate(() => desktopCommand('new-tab'));
  check(await page.evaluate(() => document.querySelector('#notice').textContent.includes('Take control first') && packets.length === 0), 'watching desktop commands send no remote input');
  // A deterministic page served from the local engine namespace, with a visible click counter.
  // CDP only prepares/observes the fixture; every assertion below uses viewer input.
  const { chromium: remoteChromium } = await import('/work/node_modules/playwright/index.mjs');
  remote = await remoteChromium.connectOverCDP('http://127.0.0.1:9110');
  const target = await remote.contexts()[0].newPage();
  await target.goto('about:blank');
  await target.evaluate(html => { document.open(); document.write(html); document.close(); }, '<style>body{font:32px system-ui;margin:0;background:#f3f7f6}button{position:absolute;inset:100px 100px 200px 100px;font:48px system-ui;background:#c3e7ed;border:2px solid #244;}</style><button id="hit" onclick="this.textContent=++window.hits">Click through Tandem</button><script>window.hits=0</script>');
  await target.bringToFront(); await delay(800);
  // Middle of remote content, clear of Neo toolbar/sidebar. First click must both take and act.
  await page.mouse.click(850, 420);
  await wait(() => document.body.classList.contains('manual'), 'click takeover');
  await target.waitForFunction(() => window.hits === 1, null, { timeout: 5000 });
  await delay(300);
  check(await target.evaluate(() => window.hits === 1), 'first takeover click reaches remote exactly once');
  await page.evaluate(() => document.querySelector('#notice').hidden = true);
  await page.screenshot({ path: out + '/manual.png' });
  const initial = await countTabs();
  await page.evaluate(() => desktopCommand('new-tab'));
  for (let i = 0; i < 50 && await countTabs() !== initial + 1; i++) await delay(100);
  check(await countTabs() === initial + 1, 'desktop new-tab reaches remote through neko key API');
  await page.evaluate(() => desktopCommand('close-tab'));
  for (let i = 0; i < 50 && await countTabs() !== initial; i++) await delay(100);
  check(await countTabs() === initial, 'desktop close-tab reaches remote');
  await page.mouse.move(850, 420);
  await page.keyboard.press('Meta+KeyL');
  for (const key of 'Tandem WebRTC keyboard') {
    if (/[A-Z]/.test(key)) await page.keyboard.press(`Shift+Key${key}`, { delay: 40 });
    else await page.keyboard.type(key, { delay: 40 });
  }
  await delay(200);
  await page.keyboard.press('Meta+KeyA'); await page.keyboard.press('Meta+KeyC');
  await wait(() => window.remoteCopied === 'Tandem WebRTC keyboard', 'remote clipboard copy');
  check(true, 'Mac Cmd maps to Control and remote clipboard writes desktop bridge');
  await page.evaluate(() => { window.localClipboard = 'Tandem local paste'; desktopCommand('edit-paste'); });
  await delay(700); await page.evaluate(() => desktopCommand('edit-select-all')); await page.evaluate(() => desktopCommand('edit-copy'));
  await wait(() => window.remoteCopied === 'Tandem local paste', 'clipboard roundtrip');
  check(true, 'local clipboard API then Ctrl+V changes remote text');
  const beforeLocal = await page.evaluate(() => packets.length);
  for (const [key, code] of [['q', 'KeyQ'], ['h', 'KeyH'], ['m', 'KeyM'], ['`', 'Backquote']]) {
    await page.locator('#neo-window textarea').dispatchEvent('keydown', { key, code, metaKey: true });
    await page.locator('#neo-window textarea').dispatchEvent('keyup', { key, code, metaKey: true });
  }
  check(await page.evaluate(n => packets.length === n, beforeLocal), 'Cmd+Q/H/M/backquote remain local');
  await page.locator('[data-mode=watch]').click(); await delay(300);
  const packetCount = await page.evaluate(() => packets.length);
  await page.keyboard.type('ignored');
  check(await page.evaluate(n => packets.length === n, packetCount), 'watch-mode keyboard ignored');
  // Emulate sustained ICE loss on a real peer, without stopping the stack or affecting others.
  const lost = Date.now();
  await page.evaluate(() => {
    const pc = peers.at(-1); Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'disconnected' }); pc.dispatchEvent(new Event('connectionstatechange'));
  });
  await delay(9200);
  check(await page.locator('video').count() === 1, 'ICE loss keeps WebRTC during ten-second grace');
  await wait(() => document.querySelector('#connection')?.textContent.includes('Live · VNC'), 'ICE fallback VNC');
  check(Date.now() - lost >= 10000, 'sustained ICE loss falls back after ten seconds');
  await page.screenshot({ path: out + '/fallback.png' });
  await page.locator('[data-mode=manual]').click();
  await wait(() => document.body.classList.contains('manual'), 'VNC manual');
  const vncTabs = await countTabs();
  await page.evaluate(() => desktopCommand('new-tab'));
  for (let i = 0; i < 50 && await countTabs() !== vncTabs + 1; i++) await delay(100);
  check(await countTabs() === vncTabs + 1, 'fallback VNC sends real desktop keyboard input');
  await page.evaluate(() => desktopCommand('close-tab'));
  for (let i = 0; i < 50 && await countTabs() !== vncTabs; i++) await delay(100);
  check(await countTabs() === vncTabs, 'fallback VNC closes remote tab');
  await page.locator('[data-mode=agent]').click();
  // Return to Neo via Lite without a page reload: this load must stay on VNC.
  await page.evaluate(() => document.querySelector('#switch-view').click());
  await wait(() => !document.body.classList.contains('neo-view') && document.querySelector('#connection')?.textContent.startsWith('Live') && document.querySelector('#empty').hidden, 'Lite screencast');
  check(true, 'Lite still connects to the real screencast');
  await page.evaluate(() => document.querySelector('#switch-view').click());
  await wait(() => document.querySelector('#connection')?.textContent.includes('Live · VNC'), 'sticky VNC');
  check(await page.locator('video').count() === 0, 'fallback remains VNC for rest of page load');
  // New load with blocked media: initial first-frame timeout also falls back.
  await context.addInitScript(() => { window.RTCPeerConnection = class { constructor() { throw new Error('forced no-media test'); } }; });
  const initialLoss = Date.now(); await page.reload();
  await wait(() => document.querySelector('#connection')?.textContent.includes('Live · VNC'), 'eight-second initial fallback');
  check(Date.now() - initialLoss >= 8000, 'no decoded frame falls back after eight seconds');
  await page.screenshot({ path: out + '/no-frame-fallback.png' });
  await page.route('**/api/me', async route => {
    const response = await route.fetch(), me = await response.json();
    await route.fulfill({ response, json: { ...me, webrtc: false } });
  });
  await page.reload();
  await wait(() => document.querySelector('#connection')?.textContent.includes('Live · VNC'), 'WebRTC disabled');
  check(await page.locator('video').count() === 0 && await page.evaluate(() => peers.length === 0), '/api/me.webrtc false starts VNC directly');
  // The forced no-media case can log a transport error; actual page errors remain failures.
  check(errors.length === 0, 'no browser runtime exceptions');
  await writeFile(out + '/results.json', JSON.stringify({ checks, errors, viewport: '1440x900 DPR 2', screenshots: ['agent.png', 'manual.png', 'fallback.png', 'no-frame-fallback.png'] }, null, 2));
  console.log(JSON.stringify({ checks: checks.length, errors }));
} catch (error) {
  await page.screenshot({ path: out + '/failure.png' }).catch(() => {});
  await writeFile(out + '/failure.json', JSON.stringify({ checks, errors, error: String(error) }, null, 2));
  throw error;
} finally { await remote?.close(); await browser.close(); }
