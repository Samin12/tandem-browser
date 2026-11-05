import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createGateway } from '../src/server';
import { Neko, nekoRoute, screenSize } from '../src/neko';

const origin = 'http://127.0.0.1:8790', admin = 'throwaway-neko-api-token', password = 'throwaway-neko-user-password';
const records: { path: string; method: string; auth: string | null; cookie: string | null; query: string; body: any }[] = [];
const tokens = new Map<string, string>(), upstreams = new Set<ServerWebSocket<{ id: string }>>();
let gateway: ReturnType<typeof createGateway>, fake: ReturnType<typeof Bun.serve>, dir: string, base: string, config: Awaited<ReturnType<typeof loadConfig>>;
let down = false, host: string | undefined, loginCount = 0, settings = {}, screen: any, delayLogin = 0;
async function until(fn: () => boolean) { for (let i = 0; i < 600; i++) { if (fn()) return; await Bun.sleep(5); } throw new Error('Timed out'); }
const cookie = (token: string) => `tandem_session=${token}`;
const get = (path: string, token: string, extra: Record<string, string> = {}) => fetch(base + path, { headers: { cookie: cookie(token), origin, ...extra } });
async function socket(path: string, token: string) {
  const messages: (string | Buffer)[] = [];
  const ws = new WebSocket(base.replace(/^http/, 'ws') + path, { headers: { cookie: cookie(token), origin } } as any); ws.binaryType = 'arraybuffer';
  ws.onmessage = e => messages.push(typeof e.data === 'string' ? e.data : Buffer.from(e.data));
  const closed = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('upgrade failed')); });
  return { ws, messages, closed };
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-neko-')); writeFileSync(join(dir, 'brand.json'), '{}');
  fake = Bun.serve<{ id: string }>({ hostname: '127.0.0.1', port: 0, async fetch(req, server) {
    const url = new URL(req.url), path = url.pathname, auth = req.headers.get('authorization');
    const body = req.method === 'POST' && req.headers.get('content-type')?.includes('json') ? await req.json() : undefined;
    records.push({ path, method: req.method, auth, cookie: req.headers.get('cookie'), query: url.search, body });
    if (path === '/websockify') { if (server.upgrade(req, { data: { id: 'vnc' } })) return; }
    if (down) return new Response('offline', { status: 503 });
    if (path === '/health') return new Response('true');
    if (path === '/api/login') {
      expect(body.password).toBe(password); expect(body.username).toMatch(/^tandem-[\da-f-]{8}$/); loginCount++;
      const id = `neko-${loginCount}`, token = `private-token-${loginCount}`; tokens.set(token, id);
      if (delayLogin) await Bun.sleep(delayLogin);
      return Response.json({ id, token });
    }
    if (auth === `Bearer ${admin}`) {
      if (path === '/api/room/settings') settings = body;
      else if (path === '/api/room/control/reset') host = undefined;
      else if (path.startsWith('/api/room/control/give/')) host = path.split('/').at(-1);
      else if (path === '/api/room/screen') screen = body;
      else if (path.startsWith('/api/sessions/')) { for (const [token, id] of tokens) if (id === path.split('/').at(-1)) tokens.delete(token); }
      return new Response(null, { status: 204 });
    }
    const id = tokens.get((auth ?? '').replace(/^Bearer /, ''));
    if (!id) return new Response('unauthorized', { status: 401 });
    if (path === '/api/ws') { if (server.upgrade(req, { data: { id } })) return; }
    if (path === '/api/whoami') return Response.json({ id, profile: { name: id } }, { headers: { 'set-cookie': 'must-not-escape=1', authorization: 'must-not-escape' } });
    return new Response('forbidden upstream route', { status: 500 });
  }, websocket: {
    open(ws) { upstreams.add(ws); ws.send(ws.data.id === 'vnc' ? Buffer.from('RFB 003.008\n') : JSON.stringify({ event: 'system/init', payload: { id: ws.data.id } })); },
    message(ws, data) { ws.send(data); }, close(ws) { upstreams.delete(ws); },
  } });
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = listener.port; listener.stop();
  config = await loadConfig({ TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD: 'throwaway-tandem-password', TANDEM_AGENT_TOKEN: 'throwaway-agent-token-0000000000000000',
    TANDEM_DATA_DIR: dir, TANDEM_PUBLIC_DIR: new URL('./fixtures/public', import.meta.url).pathname, TANDEM_BRAND_FILE: join(dir, 'brand.json'), TANDEM_LISTEN: `127.0.0.1:${port}`,
    TANDEM_CDP_URL: 'http://127.0.0.1:1', TANDEM_NEO_MCP_URL: 'http://127.0.0.1:1/mcp', TANDEM_NEKO_URL: `http://127.0.0.1:${fake.port}`,
    TANDEM_NEKO_USER_PASSWORD: password, TANDEM_NEKO_API_TOKEN: admin, TANDEM_NOVNC_URL: `http://127.0.0.1:${fake.port}` });
  gateway = createGateway(config); base = `http://127.0.0.1:${gateway.server.port}`;
  await until(() => records.some(r => r.path === '/api/room/control/reset'));
});
afterAll(async () => { await gateway.close(); void fake.stop(true); rmSync(dir, { recursive: true, force: true }); });
test('configuration requires both credentials when enabled and rejects paths/queries', async () => {
  const env = { TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD_HASH: config.passwordHash, TANDEM_AGENT_TOKEN: config.agentToken, TANDEM_NEKO_URL: 'http://localhost:8080' };
  await expect(loadConfig(env)).rejects.toThrow('TANDEM_NEKO_USER_PASSWORD');
  await expect(loadConfig({ ...env, TANDEM_NEKO_USER_PASSWORD: password })).rejects.toThrow('TANDEM_NEKO_API_TOKEN');
  for (const url of ['ftp://localhost', 'http://localhost/path', 'http://localhost/?token=x']) await expect(loadConfig({ ...env, TANDEM_NEKO_URL: url, TANDEM_NEKO_USER_PASSWORD: password, TANDEM_NEKO_API_TOKEN: admin })).rejects.toThrow('TANDEM_NEKO_URL');
  expect((await loadConfig({ ...env, TANDEM_NEKO_URL: '' })).nekoUrl).toBeUndefined();
});
test('startup locks control and health reports optional neko independently', async () => {
  expect(settings).toEqual({ locked_controls: true, implicit_hosting: false, control_protection: false });
  const { token } = gateway.sessions.create();
  expect(await (await get('/api/me', token)).json()).toMatchObject({ webrtc: true });
  expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ ok: false, neko: true });
});
test('lazy concurrent login caches per viewer, strips query/cookies, injects token and hides upstream headers', async () => {
  const { token } = gateway.sessions.create(), before = loginCount;
  const responses = await Promise.all(Array.from({ length: 5 }, () => get('/neko/api/whoami?token=attacker', token)));
  expect(loginCount).toBe(before + 1);
  for (const response of responses) { expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('authorization')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store'); expect(JSON.stringify(await response.json())).not.toContain('private-token'); }
  const request = records.filter(r => r.path === '/api/whoami').at(-1)!;
  expect(request.auth).toBe(`Bearer private-token-${loginCount}`); expect(request.cookie).toBeNull(); expect(request.query).toBe('');
  const other = gateway.sessions.create(); await get('/neko/api/whoami', other.token); expect(loginCount).toBe(before + 2);
  expect((await get('/neko/api/whoami', token, { authorization: `Bearer ${admin}` })).status).toBe(401);
});
test('401 invalidates only the stale cached login and retries once', async () => {
  const { token } = gateway.sessions.create(); const first = await (await get('/neko/api/whoami', token)).json() as any;
  for (const [key, id] of tokens) if (id === first.id) tokens.delete(key);
  const before = loginCount, second = await (await get('/neko/api/whoami', token)).json() as any;
  expect(loginCount).toBe(before + 1); expect(second.id).not.toBe(first.id);
});
test('exact allowlist blocks admin, metrics, batch, writes, encoded and trailing aliases before contacting neko', async () => {
  const { token } = gateway.sessions.create(), before = records.length;
  for (const path of ['/api/login', '/api/members', '/api/members/x', '/api/sessions', '/api/sessions/x', '/api/room/settings', '/api/room/control', '/api/room/control/request', '/api/room/control/give/x', '/api/room/screen', '/api/batch', '/metrics', '/debug/pprof', '/api/whoami/', '/api/%77hoami', '/api/whoami%2f..%2fsessions']) {
    expect((await get('/neko' + path, token)).status).toBe(404);
  }
  expect((await fetch(base + '/neko/api/whoami', { method: 'POST', headers: { cookie: cookie(token), origin, 'x-tandem': '1' } })).status).toBe(404);
  expect(records.slice(before).filter(r => r.path !== '/health' && r.auth !== `Bearer ${admin}`)).toEqual([]);
  expect(nekoRoute('GET', '/api/ws')).toBe(true); expect(nekoRoute('POST', '/api/ws')).toBe(false);
});
test('neko routes require cookie, reject foreign Origins and permit same-origin GET without Origin', async () => {
  const { token } = gateway.sessions.create();
  expect((await fetch(base + '/neko/api/whoami', { headers: { origin } })).status).toBe(401);
  expect((await get('/neko/api/ws', token)).status).toBe(426);
  expect((await fetch(base + '/neko/api/ws', { headers: { origin, upgrade: 'websocket' } })).status).toBe(401);
  expect((await get('/neko/api/whoami', token, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await fetch(base + '/neko/api/whoami', { headers: { cookie: cookie(token) } })).status).toBe(200);
  expect((await fetch(base + '/neko/api/ws', { headers: { cookie: cookie(token), upgrade: 'websocket' } })).status).toBe(403);
});
test('WebSocket preserves initial state and relays text/binary both ways, revoke closes 4401 and deletes session', async () => {
  const { token, session } = gateway.sessions.create(), { ws, messages, closed } = await socket('/neko/api/ws', token);
  await until(() => messages.length > 0); expect(JSON.parse(messages[0] as string).event).toBe('system/init');
  const request = records.filter(r => r.path === '/api/ws').at(-1)!; expect(request.auth).toMatch(/^Bearer private-token-/); expect(request.cookie).toBeNull(); expect(request.query).toBe('');
  ws.send('viewer-signalling'); ws.send(Buffer.from([1, 2, 3]));
  await until(() => messages.length >= 3); expect(messages[1]).toBe('viewer-signalling'); expect(messages[2]).toEqual(Buffer.from([1, 2, 3]));
  const id = JSON.parse(messages[0] as string).payload.id;
  gateway.sessions.revoke(session.id); expect(await closed).toBe(4401);
  await until(() => records.some(r => r.method === 'DELETE' && r.path === `/api/sessions/${id}`));
});
test('control gives the human login, replacing holder and reset follow Tandem, reconnect re-applies', async () => {
  const a = gateway.sessions.create(), b = gateway.sessions.create();
  gateway.control.take(a.session.id); const ar = await (await get('/neko/api/whoami', a.token)).json() as any;
  await until(() => host === ar.id);
  gateway.control.take(b.session.id); const br = await (await get('/neko/api/whoami', b.token)).json() as any;
  await until(() => host === br.id);
  host = undefined; const connection = await socket('/neko/api/ws', b.token); await until(() => host === br.id); connection.ws.close();
  gateway.control.release(b.session.id); await until(() => host === undefined);
  expect(records.filter(r => r.path.startsWith('/api/room/control/')).every(r => r.auth === `Bearer ${admin}`)).toBe(true);
});
test('rapid take/release during lazy login cannot leave a stale human host', async () => {
  const { session } = gateway.sessions.create(); delayLogin = 100;
  gateway.control.take(session.id); await Bun.sleep(20); gateway.control.release(session.id);
  await Bun.sleep(200); delayLogin = 0; await until(() => host === undefined);
  expect(host).toBeUndefined();
});
test('expiry and logout delete cached sessions; revoke during a login deletes the newly created session', async () => {
  for (const how of ['expiry', 'logout', 'pending']) {
    const { token, session } = gateway.sessions.create(); const before = loginCount;
    if (how === 'pending') delayLogin = 100;
    const pending = get('/neko/api/whoami', token); await until(() => loginCount > before);
    if (how !== 'pending') await pending;
    if (how === 'expiry') gateway.sessions.byId(session.id, false, Date.now() + config.maxMs + 1);
    else if (how === 'logout') expect((await fetch(base + '/api/logout', { method: 'POST', headers: { cookie: cookie(token), origin, 'x-tandem': '1' } })).status).toBe(200);
    else gateway.sessions.revoke(session.id);
    await pending; delayLogin = 0;
    await until(() => records.some(r => r.method === 'DELETE' && r.path === `/api/sessions/neko-${before + 1}`));
  }
});
test('screen validates bounds and even integers, debounces 500ms last wins through viewer WS', async () => {
  for (const [w, h] of [[319, 240], [320, 239], [3842, 240], [320, 2402], [321, 242], [320.5, 240], [NaN, 240], ['320', 240], [Infinity, 240]]) expect(screenSize(w, h)).toBe(false);
  expect(screenSize(320, 240)).toBe(true); expect(screenSize(3840, 2400)).toBe(true);
  const { token } = gateway.sessions.create(), { ws, messages } = await socket('/ws', token);
  try {
    ws.send(JSON.stringify({ t: 'hello', viewport: { w: 800, h: 600, dpr: 1 } }));
    ws.send(JSON.stringify({ t: 'screen', w: 321, h: 240 })); await until(() => messages.some(m => typeof m === 'string' && JSON.parse(m).code === 'command_failed'));
    const before = records.filter(r => r.path === '/api/room/screen').length;
    ws.send(JSON.stringify({ t: 'screen', w: 800, h: 600 })); await Bun.sleep(300);
    ws.send(JSON.stringify({ t: 'screen', w: 1280, h: 720 })); await Bun.sleep(300);
    expect(records.filter(r => r.path === '/api/room/screen').length).toBe(before);
    await until(() => screen?.width === 1280); expect(screen).toEqual({ width: 1280, height: 720, rate: 25 });
    expect(records.filter(r => r.path === '/api/room/screen').length).toBe(before + 1);
  } finally { ws.close(); }
});
test('neko down returns webrtc false while VNC remains available; recovery restores locks and control', async () => {
  const { token, session } = gateway.sessions.create(); down = true;
  try {
    expect(await (await get('/api/me', token)).json()).toMatchObject({ webrtc: false });
    expect(await (await fetch(base + '/api/health')).json()).toMatchObject({ neko: false });
    expect((await get('/neko/api/whoami', token)).status).toBe(502);
    gateway.control.take(session.id); expect(gateway.control.holds(session.id)).toBe(true);
    const vnc = await socket('/desktop/websockify', token); await until(() => vnc.messages.length > 0);
    expect(vnc.messages[0]).toEqual(Buffer.from('RFB 003.008\n')); vnc.ws.close();
  } finally { down = false; }
  settings = {}; expect(await (await get('/api/me', token)).json()).toMatchObject({ webrtc: true });
  await until(() => !!host); expect(settings).toEqual({ locked_controls: true, implicit_hosting: false, control_protection: false });
  gateway.control.release(session.id); await until(() => host === undefined);
});

test('disabled neko reports false, ignores screen messages and performs no upstream work', async () => {
  const off = new Neko({ ...config, nekoUrl: undefined }, gateway.sessions, gateway.control), before = records.length;
  off.start(); off.screen('unused', 1, 1); off.changed(); expect(await off.health()).toBe(false); await off.close();
  expect(records.length).toBe(before);
});
