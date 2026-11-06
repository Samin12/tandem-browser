#!/usr/bin/env node
/** Capture public page frames and the built viewer, using only isolated headless Chrome. */
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const out = resolve(process.argv[2] ?? '/tmp/tandem-readme-blue');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(out, { recursive: true });
execFileSync('bun', ['run', 'build'], { cwd: join(repo, 'tandem/web'), stdio: 'inherit' });
const profile = await mkdtemp(join(tmpdir(), 'tandem-docs-chrome-'));
const browser = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-gpu', '--hide-scrollbars'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let nextId = 0, buffer = '', mock;
const pending = new Map();
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const result = JSON.parse(raw), callback = pending.get(result.id);
    if (callback) { pending.delete(result.id); clearTimeout(callback.timer); result.error ? callback.reject(new Error(JSON.stringify(result.error))) : callback.resolve(result.result); }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function page(width, height) {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, sessionId);
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }, sessionId);
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  const js = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed');
    return result.result.value;
  };
  return { targetId, sessionId, js };
}
async function screenshot(sessionId, path, maxBytes = Infinity) {
  for (const quality of [92, 90, 88, 86, 84, 82, 80, 78, 76]) {
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true }, sessionId);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length <= maxBytes) { await writeFile(path, bytes); return { path, bytes: bytes.length, quality }; }
  }
  throw new Error(`JPEG exceeds size budget: ${path}`);
}
async function freePort() {
  const probe = createServer();
  await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  return port;
}
async function stopMock() {
  if (!mock) return;
  const process = mock; mock = undefined;
  process.kill();
  await new Promise(r => process.exitCode !== null ? r() : process.once('exit', r));
}
const states = [
  { name: 'agent-driving', url: 'https://www.tradingview.com/symbols/NASDAQ-AAPL/', title: 'Apple Stock Chart', manual: false, expected: 'Apple' },
  { name: 'you-driving', url: 'https://en.wikipedia.org/wiki/Tandem_bicycle', title: 'Tandem bicycle — Wikipedia', manual: true, expected: 'Tandem bicycle' },
];
const results = [];
try {
  for (const state of states) {
    // Lite viewer has 143 CSS pixels of real chrome; the page fills its canvas.
    const source = await page(1440, 757);
    await cdp('Page.navigate', { url: state.url }, source.sessionId);
    await until(async () => source.js(`document.readyState==='complete' && document.body.innerText.includes(${JSON.stringify(state.expected)})`), `${state.name} public page`, 45000);
    await delay(6000); // Allow the real chart, article images, and fonts to settle.
    // Only dismiss known public-site overlays; page content and styling stay intact.
    await source.js(`(() => {
      for (const button of document.querySelectorAll('button')) {
        if (/^(Reject all|Accept all cookies|Accept all|I agree|Agree)$/i.test(button.innerText.trim()) && button.getBoundingClientRect().width) button.click();
      }
      for (const element of document.querySelectorAll('.frb,.frb-header,.cn-fundraising,#onetrust-banner-sdk')) element.remove();
    })()`);
    await source.js('document.fonts.ready');
    await delay(1500);
    const metadata = await source.js(`({title:document.title,url:location.href,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,text:document.body.innerText.slice(0,1500)})`);
    if (/Access Denied|Just a moment|Verify you are human/i.test(metadata.title)) throw new Error(`Public page blocked: ${metadata.title}`);
    const frame = join(out, `${state.name}-frame.jpg`);
    await screenshot(source.sessionId, frame);
    await cdp('Target.closeTarget', { targetId: source.targetId });

    const tabs = states.map((s, i) => ({ targetId: `tab-${i + 1}`, title: s.title, url: s.url, loading: false, canGoBack: true, canGoForward: false, opener: 'agent' }));
    tabs.push({ targetId: 'tab-3', title: 'New Tab', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, opener: 'human' });
    const scene = join(out, `${state.name}-scene.json`);
    await writeFile(scene, JSON.stringify({ frame, width: 1440, height: 757, tabs, activeTargetId: state.manual ? 'tab-2' : 'tab-1', autoActivity: false, pendingAgentCalls: 0 }, null, 2));
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const password = crypto.randomUUID();
    mock = spawn('bun', ['dev/mock-server.ts'], { cwd: join(repo, 'tandem/web'), env: { ...process.env, PORT: String(port), TANDEM_DEV_PASSWORD: password, TANDEM_DEV_SCENE: scene }, stdio: ['ignore', 'ignore', 'inherit'] });
    await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, 'mock startup');
    const viewer = await page(1440, 900);
    await cdp('Page.navigate', { url: `${origin}/login` }, viewer.sessionId);
    await until(() => viewer.js("!!document.querySelector('#login-submit') && !document.querySelector('#login-submit').disabled"), 'viewer login');
    const login = await viewer.js(`fetch('/api/login',{method:'POST',headers:{'X-Tandem':'1','Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.ok)`);
    if (!login) throw new Error('Local mock login failed');
    await cdp('Page.navigate', { url: `${origin}/?view=lite` }, viewer.sessionId);
    await until(() => viewer.js("document.querySelector('#connection')?.textContent.startsWith('Live') && document.querySelector('#empty')?.hidden"), 'viewer frame');
    if (state.manual) {
      await viewer.js("document.querySelector('[data-mode=manual]').click()");
      await until(() => viewer.js("document.body.classList.contains('manual')"), 'manual acknowledgment');
    }
    await delay(750);
    if (!await viewer.js("document.querySelector('#notice').hidden")) throw new Error('Unexpected viewer notice');
    const ui = await viewer.js(`({title:document.title,width:innerWidth,height:innerHeight,dpr:devicePixelRatio,mode:document.querySelector('[data-mode][aria-pressed=true]').textContent,banner:document.querySelector('#banner-text').textContent,tabs:[...document.querySelectorAll('.tab-title')].map(t=>t.textContent),logo:document.querySelector('.brand-mark img').getAttribute('src'),background:getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),pageHeight:document.querySelector('#page').getBoundingClientRect().height})`);
    if (ui.width !== 1440 || ui.height !== 900 || ui.dpr !== 2 || ui.pageHeight !== 757 || ui.background.toLowerCase() !== '#f7fafd' || ui.mode !== (state.manual ? 'Manual' : 'Watch') || !ui.banner.includes(state.manual ? 'Hermes is paused' : 'Hermes is driving') || ui.tabs.some(t => /BrowserOS|Research notes/.test(t))) throw new Error(`Unexpected viewer: ${JSON.stringify(ui)}`);
    const capture = await screenshot(viewer.sessionId, join(here, '..', `${state.name}.jpg`), 600 * 1024);
    results.push({ state: state.name, source: metadata, viewer: ui, capture });
    console.log(JSON.stringify(results.at(-1), null, 2));
    await cdp('Target.closeTarget', { targetId: viewer.targetId });
    await stopMock();
  }
  await writeFile(join(out, 'capture-results.json'), JSON.stringify(results, null, 2));
} finally {
  await stopMock();
  await cdp('Browser.close').catch(() => {});
  await new Promise(r => browser.exitCode !== null ? r() : browser.once('exit', r));
  await rm(profile, { recursive: true, force: true });
}
