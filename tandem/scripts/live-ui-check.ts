// Drives the real viewer in headless Chrome against a running Tandem stack while
// an MCP client plays the agent, and saves screenshots. Never opens a window.
//
//   TANDEM_URL=http://127.0.0.1:8790 TANDEM_PASSWORD=… TANDEM_AGENT_TOKEN=… \
//     bun tandem/scripts/live-ui-check.ts [out-dir]
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const base = process.env.TANDEM_URL ?? 'http://127.0.0.1:8790';
const password = process.env.TANDEM_PASSWORD ?? '';
const agentToken = process.env.TANDEM_AGENT_TOKEN ?? '';
const totpCode = process.env.TANDEM_TOTP_CODE;
const agentUrl = process.env.TANDEM_AGENT_URL ?? 'https://www.tradingview.com/symbols/NASDAQ-AAPL/';
const humanUrl = process.env.TANDEM_HUMAN_URL ?? 'https://en.wikipedia.org/wiki/Tandem_bicycle';
const out = resolve(process.argv[2] ?? resolve(import.meta.dir, '../web/dev/screenshots/live'));
await mkdir(out, { recursive: true });
const profile = await mkdtemp(resolve(homedir(), '.cache/tandem-live-check-'));
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: string[] = [];
const pass = (label: string) => { results.push(`PASS ${label}`); console.log(`PASS ${label}`); };

async function until<T>(fn: () => Promise<T>, label: string, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await delay(200); }
  throw new Error(`Timed out: ${label}`);
}

let mcpSession = '';
let rpcId = 0;
async function mcp(method: string, params?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const body = method.startsWith('notifications/') ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  mcpSession ||= res.headers.get('mcp-session-id') ?? '';
  const text = await res.text();
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean).pop() ?? text;
  return data ? JSON.parse(data) : null;
}

const chrome = Bun.spawn([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
let ws: WebSocket | undefined;
try {
  const port = await until(async () => (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0], 'Chrome');
  const page = (await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()) as any[]).find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => (ws!.onopen = r));
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const errors: string[] = [];
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    pending.get(m.id)?.(m); pending.delete(m.id);
  };
  const cdp = (method: string, params: object = {}) => new Promise<any>(r => { pending.set(++id, r); ws!.send(JSON.stringify({ id, method, params })); });
  const js = async (expression: string) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result?.result?.value;
  const shot = async (name: string) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    await Bun.write(resolve(out, name), Buffer.from(r.result.data, 'base64'));
    pass(`screenshot ${name}`);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  await cdp('Page.navigate', { url: `${base}/login` });
  await until(() => js(`!!document.querySelector('input[type=password]')`), 'login form');
  const login = await js(`fetch('/api/login',{method:'POST',headers:{'content-type':'application/json','x-tandem':'1'},body:JSON.stringify(${JSON.stringify({ password, ...(totpCode ? { totp: totpCode } : {}) })})}).then(r=>r.status)`);
  if (login !== 200) throw new Error(`login returned ${login}`);
  pass('login');
  await js(`localStorage.setItem('tandem.mode','watch')`);
  await cdp('Page.navigate', { url: `${base}/` });
  await until(() => js(`document.querySelectorAll('#tabs [role=tab]').length > 0`), 'tab strip', 30000);
  pass('viewer connected with tabs');

  await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes', version: 'live-check' } });
  await mcp('notifications/initialized');
  const opened = await mcp('tools/call', { name: 'tabs', arguments: { action: 'new', url: agentUrl } });
  if (opened?.result?.isError) throw new Error(`agent tabs new failed: ${JSON.stringify(opened.result.content).slice(0, 300)}`);
  pass('agent opened a tab over MCP');
  await delay(9000);
  await shot('agent-driving.png');

  const clicked = await js(`(() => { const b = document.querySelector('#modes [data-mode=manual]'); b?.click(); return !!b; })()`);
  if (!clicked) throw new Error('Manual button not found');
  await until(() => js(`/You're driving/i.test(document.body.innerText)`), 'manual banner');
  pass('took manual control from the UI');
  const held = mcp('tools/call', { name: 'tabs', arguments: { action: 'list' } });
  await js(`(() => { const i = document.querySelector('#address'); i.focus(); i.value = ${JSON.stringify(humanUrl)}; i.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#address-form').requestSubmit(); return true; })()`);
  await delay(7000);
  await shot('you-driving.png');
  const pendingText = await js(`document.body.innerText.match(/\\d+ waiting/)?.[0] ?? ''`);
  if (pendingText) pass(`viewer shows Hermes waiting (${pendingText})`);

  await js(`document.querySelector('#modes [data-mode=agent]').click()`);
  const heldResult = await Promise.race([held, delay(30000).then(() => null)]);
  if (heldResult && !heldResult.result?.isError) pass('held agent call ran after hand-back');
  else console.log('NOTE held call result:', JSON.stringify(heldResult)?.slice(0, 300));
  if (errors.length) console.log('Page errors:', errors);
  else pass('no page errors');
} finally {
  ws?.close(); chrome.kill(); await chrome.exited; await rm(profile, { recursive: true, force: true });
}
console.log(`${results.length} checks passed; screenshots in ${out}`);
