import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentCdpConnection, agentAuthorized, cdpReadOnly, cdpRoute, CDP_PAUSED, rewriteCdp } from '../src/agent-cdp';
import { Audit } from '../src/audit';
import { Control } from '../src/control';
import { loadConfig } from '../src/config';
import { createGateway } from '../src/server';

const token = 'test-agent-token-00000000000000000000000', origin = 'http://127.0.0.1:8790';
const wait = async (fn: () => boolean) => { for (let i = 0; i < 400; i++) { if (fn()) return; await Bun.sleep(5); } throw new Error('Timed out'); };
test('CDP path and bearer parsing, encoded tokens and exact browser/page socket paths', () => {
  expect(cdpRoute('/cdp/json/version/')).toEqual({ path: '/json/version', socket: false, token: undefined });
  expect(cdpRoute('/cdp/json/version')).toEqual({ path: '/json/version', socket: false, token: undefined });
  expect(cdpRoute('/cdp/a%2Bb/devtools/browser/abc-123')).toEqual({ path: '/devtools/browser/abc-123', socket: true, token: 'a+b' });
  expect(cdpRoute('/cdp/t/devtools/page/page1')?.socket).toBe(true);
  for (const path of ['/cdp/t/devtools/page/a/b', '/cdp/t/devtools/frontend', '/cdp/t/devtools/page/%2f']) expect(cdpRoute(path)?.socket).toBe(false);
  expect(cdpRoute('/cdp/%ZZ/json')).toBeUndefined(); expect(cdpRoute('/other')).toBeUndefined();
  const req = (auth?: string) => new Request('http://local', { headers: auth ? { authorization: auth } : {} });
  expect(agentAuthorized(req(), token, token)).toBe(true); expect(agentAuthorized(req(`Bearer ${token}`), token)).toBe(true);
  for (const auth of [undefined, token, 'Bearer wrong', 'bearer ' + token]) expect(agentAuthorized(req(auth), token)).toBe(false);
  expect(agentAuthorized(req(`Bearer ${token}`), token, 'wrong')).toBe(false);
});
test('discovery rewrites nested debugger URLs and frontend ws parameters with configured origin', () => {
  const input = [{ webSocketDebuggerUrl: 'ws://localhost:9110/devtools/page/abc', devtoolsFrontendUrl: '/devtools/inspector.html?ws=localhost:9110/devtools/page/abc&x=1', nested: { webSocketDebuggerUrl: 'ws://localhost:9110/devtools/browser/def' } }];
  const output = rewriteCdp(input, 'https://browser.example', 'a+b');
  expect(output[0].webSocketDebuggerUrl).toBe('wss://browser.example/cdp/a%2Bb/devtools/page/abc');
  expect(new URL(output[0].devtoolsFrontendUrl).searchParams.get('wss')).toBe('browser.example/cdp/a%2Bb/devtools/page/abc');
  expect(new URL(output[0].devtoolsFrontendUrl).searchParams.has('ws')).toBe(false);
  expect(output[0].nested.webSocketDebuggerUrl).toBe('wss://browser.example/cdp/a%2Bb/devtools/browser/def');
  expect(rewriteCdp(input, origin)[0].webSocketDebuggerUrl).toBe('ws://127.0.0.1:8790/cdp/devtools/page/abc');
});
test('only the specified read allowlist bypasses human control', () => {
  for (const method of ['Target.getTargets', 'Target.getTargetInfo', 'Target.getBrowserContexts', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.attachToTarget', 'Target.detachFromTarget', 'Browser.getVersion', 'Page.enable', 'Network.disable', 'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'Page.getNavigationHistory', 'DOM.getDocument', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.getOuterHTML', 'DOM.resolveNode', 'DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree', 'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup']) expect(cdpReadOnly(method)).toBe(true);
  for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Input.dispatchMouseEvent', 'Page.navigate', 'Target.createTarget', 'Target.closeTarget', 'Target.activateTarget', 'Target.sendMessageToTarget', 'Network.getCookies', 'Page.enableExtra']) expect(cdpReadOnly(method)).toBe(false);
});
function fixture(ms = 1000) {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-agent-cdp-')), audit = new Audit(dir), control = new Control(dir, audit);
  const upstream: string[] = [], received: any[] = [];
  const connection = new AgentCdpConnection({ send: raw => received.push(JSON.parse(raw)), close() {} }, { send: raw => upstream.push(raw), close() {} }, control, audit, ms);
  return { control, connection, upstream, received, audit, cleanup() { connection.close(); control.close(); audit.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('human queues mutations in order; reads and browser events pass; release updates agent state', async () => {
  const f = fixture();
  try {
    f.control.take('human');
    for (const [id, method] of [[1, 'Runtime.evaluate'], [2, 'Page.navigate'], [3, 'Browser.getVersion']] as const) f.connection.message(JSON.stringify({ id, method }));
    expect(f.upstream.map(raw => JSON.parse(raw).id)).toEqual([3]);
    f.connection.response('{"id":3,"result":{}}'); f.connection.response('{"method":"Page.loadEventFired"}');
    expect(f.received).toHaveLength(2); expect(f.control.activeAgentCalls).toBe(0);
    f.control.release(); await wait(() => f.upstream.length === 3);
    expect(f.upstream.map(raw => JSON.parse(raw).id)).toEqual([3, 1, 2]);
    expect(f.control.state('').agentBusy).toBe(true); expect(f.control.lastAgentTool?.name).toBe('Page.navigate');
    f.connection.response('{"id":1,"result":{}}'); f.connection.response('{"id":2,"error":{"code":-1}}');
    expect(f.control.activeAgentCalls).toBe(0);
    f.connection.close(); const end = f.audit.tail(10).find((e: any) => e.event === 'cdp.disconnect') as any;
    expect(end.detail).toMatchObject({ messages: 3, held: 2, rejected: 0 }); expect(end.detail.topMethods.length).toBe(3);
  } finally { f.cleanup(); }
});
test('held command timeout preserves ID and session, never forwards or logs bodies', async () => {
  const f = fixture(30);
  try {
    f.control.take('human'); f.connection.message(JSON.stringify({ id: 42, sessionId: 'attached', method: 'Runtime.evaluate', params: { expression: 'secret-text' } }));
    await wait(() => f.received.length === 1);
    expect(f.received[0]).toEqual({ id: 42, sessionId: 'attached', error: { code: -32000, message: CDP_PAUSED } });
    f.control.release(); await Bun.sleep(10); expect(f.upstream).toHaveLength(0);
    f.connection.close(); expect(JSON.stringify(f.audit.tail(20))).not.toContain('secret-text'); expect(f.control.pendingAgentCalls).toBe(0);
  } finally { f.cleanup(); }
});
test('disconnect cancels held commands and finishes in-flight agent state', async () => {
  const f = fixture();
  try {
    f.connection.message('{"id":1,"method":"Browser.getVersion"}'); f.control.take('human'); f.connection.message('{"id":2,"method":"Runtime.evaluate"}'); f.connection.close();
    f.control.release(); await Bun.sleep(10); expect(f.upstream).toHaveLength(1); expect(f.received).toHaveLength(0); expect(f.control.activeAgentCalls).toBe(0); expect(f.control.pendingAgentCalls).toBe(0);
  } finally { f.cleanup(); }
});
let gateway: ReturnType<typeof createGateway>, fake: ReturnType<typeof Bun.serve>, dir: string, base: string, config: Awaited<ReturnType<typeof loadConfig>>;
const hosts: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-cdp-http-')); writeFileSync(join(dir, 'brand.json'), '{}');
  fake = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) {
    const path = new URL(req.url).pathname; hosts.push(req.headers.get('host')!);
    if (path.startsWith('/devtools/')) { if (server.upgrade(req, { data: undefined })) return; }
    if (path.startsWith('/json')) return Response.json(path === '/json/version' ? { webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/browser/test` } : [{ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/test` }]);
    return new Response('', { status: 404 });
  }, websocket: { message(ws, raw) {
    const command = JSON.parse(String(raw)); ws.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result: command.method === 'Page.captureScreenshot' ? { data: 'x'.repeat(5 * 1024 * 1024) } : {} }));
  } } });
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = listener.port; listener.stop();
  config = await loadConfig({ TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD: 'throwaway-password', TANDEM_AGENT_TOKEN: token,
    TANDEM_DATA_DIR: dir, TANDEM_PUBLIC_DIR: new URL('./fixtures/public', import.meta.url).pathname, TANDEM_BRAND_FILE: join(dir, 'brand.json'), TANDEM_LISTEN: `127.0.0.1:${port}`,
    TANDEM_CDP_URL: `http://127.0.0.1:${fake.port}`, TANDEM_NEO_MCP_URL: 'http://127.0.0.1:1/mcp' });
  gateway = createGateway(config); base = `http://127.0.0.1:${gateway.server.port}`;
});
afterAll(async () => { await gateway.close(); void fake.stop(true); rmSync(dir, { recursive: true, force: true }); });
async function socket(headers = {}, path = `/cdp/${token}/devtools/browser/test`) {
  const ws = new WebSocket(base.replace('http', 'ws') + path, { headers } as any), received: any[] = [];
  ws.onmessage = event => received.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('CDP connect failed')); }); return { ws, received };
}
test('gateway authenticates and rewrites discovery, fixes Host and blocks other endpoints', async () => {
  for (const path of ['/cdp/json/version', '/cdp/wrong/json/version']) { const response = await fetch(base + path); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'unauthorized' }); }
  for (const suffix of ['/json/version', '/json', '/json/list', '/json/version/', '/json/', '/json/list/']) {
    const response = await fetch(base + `/cdp/${token}` + suffix, { headers: { host: 'evil.example' } }); expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain(`ws://127.0.0.1:8790/cdp/${token}/devtools/`);
  }
  expect(JSON.stringify(await (await fetch(base + '/cdp/json/version', { headers: { authorization: `Bearer ${token}` } })).json())).toContain('/cdp/devtools/browser/test');
  expect(hosts.every(host => host === `127.0.0.1:${fake.port}`)).toBe(true);
  for (const path of ['/json/new', '/json/close/abc', '/json/activate/abc', '/json/protocol', '/devtools/inspector.html']) expect((await fetch(base + `/cdp/${token}` + path)).status).toBe(404);
  expect((await fetch(base + `/cdp/${token}/json`, { method: 'POST' })).status).toBe(404);
});
test('multi-megabyte screenshot responses and header-authenticated page sockets work', async () => {
  const { ws, received } = await socket({ authorization: `Bearer ${token}` }, '/cdp/devtools/page/test');
  try { ws.send('{"id":93,"method":"Page.captureScreenshot"}'); await wait(() => received.length > 0); expect(received[0].result.data.length).toBe(5 * 1024 * 1024); } finally { ws.close(); }
});
test('eight connection limit recovers capacity after disconnect', async () => {
  const sockets: WebSocket[] = [];
  try {
    await Bun.sleep(20); for (let i = 0; i < 8; i++) sockets.push((await socket()).ws);
    expect((await fetch(base + `/cdp/${token}/devtools/browser/test`, { headers: { upgrade: 'websocket' } })).status).toBe(429);
    const ws = sockets.pop()!; const closed = new Promise<void>(resolve => { ws.onclose = () => resolve(); }); ws.close(); await closed; await Bun.sleep(10); sockets.push((await socket()).ws);
  } finally { for (const ws of sockets) ws.close(); }
});
test('CDP off returns 404 and invalid configuration is rejected', async () => {
  config.agentCdp = false;
  try { expect((await fetch(base + `/cdp/${token}/json/version`)).status).toBe(404); } finally { config.agentCdp = true; }
  await expect(loadConfig({ TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD_HASH: config.passwordHash, TANDEM_AGENT_TOKEN: token, TANDEM_CDP: 'maybe' })).rejects.toThrow('TANDEM_CDP');
});
