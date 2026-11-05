// Headless acceptance in the disposable engine namespace; never opens a host window.
import { chromium } from '/work/node_modules/playwright/index.mjs';
const base = 'http://127.0.0.1:8790';
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const errors = [], checks = [];
const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); console.log('PASS', name); };
await context.addInitScript(() => {
  window.sockets = []; window.hiddenForTest = false;
  Object.defineProperty(document, 'visibilityState', { get: () => window.hiddenForTest ? 'hidden' : 'visible' });
  const Socket = window.WebSocket;
  window.WebSocket = new Proxy(Socket, { construct(Target, args) { const ws = Reflect.construct(Target, args); window.sockets.push(ws); return ws; } });
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
const live = () => page.waitForFunction(() => document.querySelector('#connection')?.textContent.includes('Live · WebRTC'));
const visibility = hidden => page.evaluate(value => { window.hiddenForTest = value; document.dispatchEvent(new Event('visibilitychange')); }, hidden);
const admin = async () => (await fetch('http://127.0.0.1:8080/api/room/control', { headers: { authorization: 'Bearer tandem-local-neko-api-token-000000000000' } })).json();
try {
  await page.goto(base + '/login'); await page.locator('#password').fill('tandem-local-test-password'); await page.locator('#login-submit').click();
  await live(); check(await page.evaluate(() => document.querySelector('video').currentTime > 0), 'decoded WebRTC video before pause');
  await page.locator('[data-mode=manual]').click(); await page.waitForFunction(() => document.body.classList.contains('manual'));
  await visibility(true); await page.waitForTimeout(1000); await visibility(false);
  check(await page.evaluate(() => sockets.filter(s => s.url.endsWith('/neko/api/ws')).length === 1 && sockets.find(s => s.url.endsWith('/neko/api/ws')).readyState === 1), 'short hide keeps the same signalling socket');
  await visibility(true);
  await page.waitForFunction(() => document.querySelector('#connection')?.textContent === 'Paused', null, { timeout: 20000, polling: 100 });
  check(await page.evaluate(() => sockets.find(s => s.url.endsWith('/neko/api/ws')).readyState === 3), '15-second hide disconnects neko signalling');
  check(await page.evaluate(() => sockets.find(s => s.url.endsWith('/ws') && !s.url.endsWith('/neko/api/ws')).readyState === 1 && document.body.classList.contains('manual')), 'control socket and human ownership survive pause');
  await page.waitForTimeout(11000);
  check(await page.evaluate(() => document.querySelector('#connection').textContent === 'Paused' && sockets.every(s => !s.url.includes('/desktop/websockify'))), 'intentional pause never triggers VNC fallback');
  const before = Date.now(); await visibility(false); await live();
  check(Date.now() - before < 8000 && await page.evaluate(() => sockets.filter(s => s.url.endsWith('/neko/api/ws')).length === 2), 'visible resumes immediately and decodes a fresh frame');
  const identity = await page.evaluate(async () => (await (await fetch('/neko/api/whoami')).json()).id);
  let control;
  for (let i = 0; i < 100; i++) { control = await admin(); if (control.host_id === identity) break; await page.waitForTimeout(50); }
  check(control.host_id === identity, 'human receives neko host again on reconnect');
  check(errors.length === 0, 'no browser runtime exceptions');
  await page.locator('[data-mode=agent]').click();
  console.log(`${checks.length} pass, 0 fail`);
} catch (error) {
  console.log('FAIL STATE', await page.evaluate(() => ({ visibility: document.visibilityState, connection: document.querySelector('#connection')?.textContent,
    sockets: sockets.map(s => ({ url: s.url, state: s.readyState })), text: document.body.innerText })), errors);
  throw error;
} finally { await browser.close(); }
