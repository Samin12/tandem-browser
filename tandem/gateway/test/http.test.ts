import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { createGateway } from '../src/server';
import { encodeBase32, totp } from '../src/security';

let gateway: ReturnType<typeof createGateway>, base: string, dir: string;
const password = randomBytes(20).toString('base64url'), agent = randomBytes(36).toString('base64url'), secret = encodeBase32(randomBytes(20));
const origin = 'http://127.0.0.1:8790';
let cookie = '';
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-http-'));
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ productName: 'Tandem Browser' }));
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = socket.port; socket.stop();
  const config = await loadConfig({ TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD: password, TANDEM_AGENT_TOKEN: agent, TANDEM_TOTP_SECRET: secret,
    TANDEM_DATA_DIR: dir, TANDEM_PUBLIC_DIR: new URL('./fixtures/public', import.meta.url).pathname, TANDEM_BRAND_FILE: join(dir, 'brand.json'), TANDEM_LISTEN: `127.0.0.1:${port}`,
    TANDEM_CDP_URL: 'http://127.0.0.1:1', TANDEM_NEO_MCP_URL: 'http://127.0.0.1:1/mcp' });
  gateway = createGateway(config); base = `http://127.0.0.1:${gateway.server.port}`;
});
afterAll(async () => { await gateway.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { origin, 'x-tandem': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
test('health and auth config are public, no internal details', async () => {
  expect(await (await fetch(base + '/api/health')).json()).toEqual({ ok: false, cdp: false, mcp: false, version: '0.1.0' });
  expect(await (await fetch(base + '/api/auth-config')).json()).toEqual({ totp: true, productName: 'Tandem Browser' });
});
test('unauthenticated me/ws rejected; app shell redirects and login is public', async () => {
  expect((await fetch(base + '/api/me')).status).toBe(401);
  expect((await fetch(base + '/ws', { headers: { origin, upgrade: 'websocket' } })).status).toBe(401);
  expect((await fetch(base + '/', { redirect: 'manual' })).status).toBe(302);
  expect((await fetch(base + '/login')).status).toBe(200);
});
test('wrong Origin, missing Origin and missing X-Tandem rejected before login', async () => {
  expect((await post('/api/login', {}, { origin: 'http://evil.example' })).status).toBe(403);
  expect((await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await post('/api/login', {}, { 'x-tandem': '' })).status).toBe(403);
});
test('password and TOTP failures return identical responses', async () => {
  const first = await post('/api/login', { password: 'wrong', totp: totp(secret) }); const second = await post('/api/login', { password, totp: 'invalid' });
  expect(first.status).toBe(401); expect(second.status).toBe(401); expect(await first.json()).toEqual(await second.json());
});
test('login creates cookie and me session', async () => {
  const response = await post('/api/login', { password, totp: totp(secret) }); expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!; expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
  expect(await (await fetch(base + '/api/me', { headers: { cookie } })).json()).toMatchObject({ user: 'owner', totp: true });
  expect((await fetch(base + '/', { headers: { cookie } })).status).toBe(200);
});
test('agent bearer cannot authenticate viewer routes; cookies cannot authenticate MCP', async () => {
  expect((await fetch(base + '/api/me', { headers: { authorization: `Bearer ${agent}` } })).status).toBe(401);
  expect((await fetch(base + '/api/me', { headers: { cookie, authorization: `Bearer ${agent}` } })).status).toBe(401);
  expect((await post('/mcp', { method: 'ping' }, { cookie })).status).toBe(401);
  expect((await post('/mcp', { method: 'ping' }, { authorization: 'Bearer wrong' })).status).toBe(401);
});
test('five failed login attempts produce 429 with Retry-After, isolated IPs', async () => {
  for (let i = 0; i < 5; i++) expect((await post('/api/login', { password: 'wrong' }, { 'x-forwarded-for': '8.8.8.8' })).status).toBe(401);
  const response = await post('/api/login', { password, totp: totp(secret) }, { 'x-forwarded-for': '8.8.8.8' }); expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
});
test('parallel login attempts cannot bypass per-IP rate limit', async () => {
  const attempts = await Promise.all(Array.from({ length: 8 }, () => post('/api/login', { password: 'wrong' }, { 'x-forwarded-for': '9.9.9.9' })));
  expect(attempts.map(r => r.status).sort()).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
});
test('public assets cannot traverse into the protected app shell', async () => {
  const response = await fetch(base + '/assets/..%2findex.html'); expect(response.status).toBe(404);
});
test('desktop HTTP files require session; desktop upgrade requires cookie and Origin', async () => {
  expect((await fetch(base + '/desktop/')).status).toBe(401);
  const redirect = await fetch(base + '/desktop/', { headers: { cookie }, redirect: 'manual' }); expect(redirect.status).toBe(302); expect(redirect.headers.get('location')).toBe('/desktop/vnc.html?path=desktop/websockify&autoconnect=1&resize=remote&reconnect=1');
  expect((await fetch(base + '/desktop/websockify', { headers: { origin, upgrade: 'websocket' } })).status).toBe(401);
  expect((await fetch(base + '/desktop/websockify', { headers: { cookie, origin: 'http://evil.example', upgrade: 'websocket' } })).status).toBe(403);
  expect((await fetch(base + '/desktop/websockify', { headers: { cookie, upgrade: 'websocket' } })).status).toBe(403);
});
test('raw CDP, binary input and missing hello are protocol violations (4403)', async () => {
  for (const payload of [JSON.stringify({ t: 'Input.dispatchKeyEvent' }), new Uint8Array([1]), JSON.stringify({ t: 'ping', ts: 1 })]) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin } } as any);
    const close = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); });
    await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
    if (typeof payload === 'string' && payload.includes('Input.')) ws.send(JSON.stringify({ t: 'hello', viewport: { w: 100, h: 100, dpr: 1 } }));
    ws.send(payload); expect(await close).toBe(4403);
  }
});
test('control release bypasses an outstanding input command and revokes its dispatch', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin } } as any);
  const received: any[] = []; ws.onmessage = e => received.push(JSON.parse(String(e.data)));
  await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
  ws.send(JSON.stringify({ t: 'hello', viewport: { w: 100, h: 100, dpr: 1 } })); ws.send(JSON.stringify({ t: 'control.take' }));
  for (let i = 0; i < 100 && gateway.control.controller !== 'human'; i++) await Bun.sleep(5);
  let unblock!: () => void, entered = false, dispatched = false;
  const barrier = new Promise<void>(resolve => { unblock = resolve; });
  const originalSession = gateway.cdp.session, originalSend = gateway.cdp.send;
  gateway.cdp.tabs.set('delayed', { targetId: 'delayed', url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, opener: 'unknown' });
  gateway.cdp.session = async () => { entered = true; await barrier; return 'session'; };
  gateway.cdp.send = async () => { dispatched = true; return {}; };
  try {
    ws.send(JSON.stringify({ t: 'input.text', targetId: 'delayed', text: 'throwaway' }));
    for (let i = 0; i < 100 && !entered; i++) await Bun.sleep(5); expect(entered).toBe(true);
    ws.send(JSON.stringify({ t: 'control.release' }));
    for (let i = 0; i < 100 && gateway.control.controller === 'human'; i++) await Bun.sleep(5);
    expect(gateway.control.controller).toBe('agent'); unblock();
    for (let i = 0; i < 100 && !received.some(m => m.code === 'not_in_control'); i++) await Bun.sleep(5);
    expect(received.some(m => m.code === 'not_in_control')).toBe(true); expect(dispatched).toBe(false);
  } finally { unblock(); gateway.cdp.session = originalSession; gateway.cdp.send = originalSend; gateway.cdp.tabs.delete('delayed'); ws.close(); }
});
test('follow viewer messages are per socket, work without control and stop on disconnect', async () => {
  const sockets: WebSocket[] = [], messages: any[][] = [], calls: string[] = [], original = gateway.cdp.activate;
  const wait = async (fn: () => boolean) => { for (let i = 0; i < 200; i++) { if (fn()) return; await Bun.sleep(5); } throw new Error('Timed out'); };
  const command = async (i: number, value: unknown) => {
    const ts = crypto.randomUUID(); sockets[i]!.send(JSON.stringify(value)); sockets[i]!.send(JSON.stringify({ t: 'ping', ts }));
    await wait(() => messages[i]!.some(m => m.t === 'pong' && m.ts === ts));
  };
  gateway.cdp.activate = async targetId => { calls.push(targetId); };
  try {
    for (let i = 0; i < 2; i++) {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin } } as any); sockets.push(ws); messages.push([]);
      ws.onmessage = e => messages[i]!.push(JSON.parse(String(e.data)));
      await new Promise<void>(resolve => { ws.onopen = () => resolve(); });
      await command(i, { t: 'hello', viewport: { w: 100, h: 100, dpr: 1 } });
      await command(i, { t: 'follow', enabled: true });
    }
    expect(gateway.control.controller).toBe('agent'); await command(0, { t: 'follow', enabled: false });
    gateway.cdp.emit('activity', { t: 'agent.activity', targetId: 'first' }); expect(calls).toEqual(['first']);
    gateway.control.take((await (await fetch(base + '/api/me', { headers: { cookie } })).json() as any).sessionId);
    gateway.cdp.emit('activity', { t: 'agent.activity', targetId: 'human' }); expect(calls).toEqual(['first']);
    gateway.control.release();
    await command(1, { t: 'follow', enabled: 'invalid' }); expect(messages[1]!.some(m => m.t === 'error' && m.code === 'command_failed')).toBe(true);
    const closed = new Promise<void>(resolve => { sockets[1]!.onclose = () => resolve(); }); sockets[1]!.close(); await closed;
    gateway.cdp.emit('activity', { t: 'agent.activity', targetId: 'disconnected' }); await Bun.sleep(550); expect(calls).toEqual(['first']);
  } finally { gateway.cdp.activate = original; for (const ws of sockets) ws.close(); gateway.control.release(); }
});
test('socket welcome, typed input refusal, take/release, protocol violations, logout closes 4401', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie, origin } } as any);
  const messages: any[] = []; ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')); });
  await Bun.sleep(10); expect(messages[0].t).toBe('welcome');
  ws.send(JSON.stringify({ t: 'hello', viewport: { w: 100, h: 100, dpr: 1 } })); ws.send(JSON.stringify({ t: 'input.text', targetId: 'x', text: 'secret' }));
  await Bun.sleep(10); expect(messages.some(m => m.code === 'not_in_control')).toBe(true);
  ws.send(JSON.stringify({ t: 'control.take' })); await Bun.sleep(10); expect(gateway.control.controller).toBe('human');
  const close = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); }); const response = await post('/api/logout', {}, { cookie });
  expect(response.status).toBe(200); expect(await close).toBe(4401); expect(gateway.control.controller).toBe('agent'); expect((await fetch(base + '/api/me', { headers: { cookie } })).status).toBe(401);
});
