import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createGateway } from '../src/server';

let gateway: ReturnType<typeof createGateway>, fake: ReturnType<typeof Bun.serve>, base: string, privateBase: string, dir: string, config: Awaited<ReturnType<typeof loadConfig>>;
const agent = crypto.randomUUID() + crypto.randomUUID(), origin = 'https://tandem.example.ts.net', user = 'Samin@AIAnswer.us';
const identity = { 'tailscale-user-login': user };
const port = () => { const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = socket.port; socket.stop(); return port; };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-tailscale-'));
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ productName: 'Tandem Browser' }));
  fake = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (new URL(req.url).pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: `${new URL(req.url).origin.replace('http', 'ws')}/devtools/browser/fake` });
    if (req.method === 'GET') return new Response(null, { status: 404 });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    const rpc = await req.json() as any;
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: rpc.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } : rpc.method === 'tools/list' ? { tools: [] } : { pong: true } });
  } });
  const publicPort = port(); let privatePort = port(); while (privatePort === publicPort) privatePort = port();
  config = await loadConfig({ TANDEM_PUBLIC_ORIGIN: `${origin},https://public.example.com`, TANDEM_VIEWER_AUTH: 'tailscale', TANDEM_TAILSCALE_USERS: 'samin@aianswer.us', TANDEM_AGENT_TOKEN: agent,
    TANDEM_DATA_DIR: dir, TANDEM_PUBLIC_DIR: new URL('./fixtures/public', import.meta.url).pathname, TANDEM_BRAND_FILE: join(dir, 'brand.json'), TANDEM_LISTEN: `127.0.0.1:${publicPort}`, TANDEM_PRIVATE_LISTEN: `127.0.0.1:${privatePort}`,
    TANDEM_CDP_URL: `http://127.0.0.1:${fake.port}`, TANDEM_NEO_MCP_URL: `http://127.0.0.1:${fake.port}/mcp` });
  gateway = createGateway(config); base = `http://127.0.0.1:${gateway.server.port}`; privateBase = `http://127.0.0.1:${gateway.privateServer!.port}`;
});
afterAll(async () => {
  try {
    await gateway?.close();
    for (const url of [base, privateBase]) await expect(fetch(url)).rejects.toThrow();
  } finally { await fake?.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
test('public listener hides all viewer routes even with forged identity and a valid cookie', async () => {
  const login = await fetch(privateBase + '/login', { headers: identity, redirect: 'manual' }), cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  for (const path of ['/', '/login', '/login.html', '/api/auth-config', '/api/me', '/api/audit', '/brand.json', '/ws', '/neko/api/ws', '/desktop/', '/desktop/websockify', '/assets/app.js', '/favicon.svg', '/mcp/']) {
    const response = await fetch(base + path, { headers: { ...identity, cookie, origin, upgrade: 'websocket', authorization: `Bearer ${agent}` }, redirect: 'manual' });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
  }
  for (const path of ['/api/login', '/api/logout', '/api/health']) {
    const response = await fetch(base + path, { method: 'POST' }); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
  }
});
test('both listeners keep health and bearer-only agent access without Tailscale identity', async () => {
  for (const url of [base, privateBase]) {
    expect((await fetch(url + '/api/health')).status).toBe(200);
    for (const headers of [{}, { authorization: 'Bearer wrong' }, identity] as Record<string, string>[]) {
      expect((await fetch(url + '/mcp', { headers })).status).toBe(401);
      expect((await fetch(url + '/cdp/json/version', { headers })).status).toBe(401);
    }
    const response = await fetch(url + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { pong: true } });
    const cdpOrigin = url === base ? 'wss://public.example.com' : origin.replace('https', 'wss');
    for (const path of ['/cdp/json/version', `/cdp/${agent}/json/version`]) {
      const discovery = await fetch(url + path, { headers: { authorization: `Bearer ${agent}` } }); expect(discovery.status).toBe(200);
      expect(await discovery.json()).toEqual({ webSocketDebuggerUrl: `${cdpOrigin}/cdp${path.includes(agent) ? '/' + agent : ''}/devtools/browser/fake` });
    }
  }
});
test('private viewer requires an allowed Tailscale identity on every request', async () => {
  for (const path of ['/', '/login', '/login.html', '/api/auth-config', '/api/me', '/ws', '/neko/api/ws', '/desktop/', '/assets/app.js']) {
    for (const headers of [{}, { 'tailscale-user-login': 'other@example.com' }, { 'tailscale-user-login': '' }] as Record<string, string>[]) {
      const response = await fetch(privateBase + path, { headers, redirect: 'manual' });
      expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'tailscale_required' });
    }
  }
  expect((await fetch(privateBase + '/', { headers: identity, redirect: 'manual' })).headers.get('location')).toBe(origin + '/login');
  expect(await (await fetch(privateBase + '/api/auth-config', { headers: identity })).json()).toEqual({ mode: 'tailscale', totp: false, productName: 'Tandem Browser' });
});
test('Tailscale navigation silently creates an audited session with existing viewer checks', async () => {
  for (const path of ['/login', '/login.html']) {
    const login = await fetch(privateBase + path, { headers: identity, redirect: 'manual' });
    expect(login.status).toBe(302); expect(login.headers.get('location')).toBe('/'); expect(login.headers.get('cache-control')).toBe('no-store');
    const setCookie = login.headers.get('set-cookie')!; expect(setCookie).toContain('HttpOnly; SameSite=Strict'); expect(setCookie).toContain('; Secure');
    const cookie = setCookie.split(';')[0]!, headers = { ...identity, cookie };
    expect((await fetch(privateBase + '/', { headers })).status).toBe(200);
    const me = await (await fetch(privateBase + '/api/me', { headers })).json() as any; expect(me).toMatchObject({ user: 'owner', totp: false });
    expect(gateway.audit.tail(10).find(entry => entry.sessionId === me.sessionId && entry.event === 'login.ok')).toMatchObject({ actor: 'human', detail: { via: 'tailscale', user } });
    const again = await fetch(privateBase + path, { headers, redirect: 'manual' });
    expect(again.status).toBe(302); expect(again.headers.get('set-cookie')).toBeNull();
    expect((await fetch(privateBase + '/api/me', { headers: { cookie } })).status).toBe(403);
    expect((await fetch(privateBase + '/api/me', { headers: { ...headers, authorization: `Bearer ${agent}` } })).status).toBe(401);
    expect((await fetch(privateBase + '/ws', { headers: identity })).status).toBe(403);
    expect((await fetch(privateBase + '/ws', { headers: { ...identity, origin } })).status).toBe(401);
    const ws = new WebSocket(privateBase.replace('http', 'ws') + '/ws', { headers: { ...headers, origin } } as any);
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')); });
    const closed = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); }); gateway.sessions.revoke(me.sessionId);
    expect(await closed).toBe(4401);
    expect((await fetch(privateBase + '/api/me', { headers })).status).toBe(401);
    expect((await fetch(privateBase + '/', { headers, redirect: 'manual' })).headers.get('location')).toBe(origin + '/login');
  }
});
test('password login is absent in tailscale mode', async () => {
  for (const headers of [{}, identity, { ...identity, origin, 'x-tandem': '1', 'content-type': 'application/json' }]) {
    const response = await fetch(privateBase + '/api/login', { method: 'POST', headers, body: '{}' }); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
  }
});
test('an empty allowlist accepts any nonempty Tailscale login', async () => {
  const users = config.tailscaleUsers; config.tailscaleUsers = [];
  try {
    const response = await fetch(privateBase + '/login', { headers: { 'tailscale-user-login': 'other@example.com' }, redirect: 'manual' }); expect(response.status).toBe(302); expect(response.headers.get('set-cookie')).toContain('tandem_session=');
    expect((await fetch(privateBase + '/login', { redirect: 'manual' })).status).toBe(403);
  } finally { config.tailscaleUsers = users; }
});
