import { resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import type { Control, Message, RemoteDialog, RemoteTab } from '../src/types';
const brand = await Bun.file(resolve(import.meta.dir, '../../branding/brand.json')).json();
// Optional local fixture for repeatable documentation captures. Production never
// imports this server; normal visual checks retain the original sample and timing.
const scene: { frame?: string; width?: number; height?: number; tabs?: RemoteTab[]; activeTargetId?: string; autoActivity?: boolean; pendingAgentCalls?: number } = process.env.TANDEM_DEV_SCENE
  ? await Bun.file(process.env.TANDEM_DEV_SCENE).json() : {};
const jpeg = new Uint8Array(await Bun.file(scene.frame || resolve(import.meta.dir, 'sample-frame.jpg')).arrayBuffer());
const dist = resolve(import.meta.dir, '../dist');
const password = process.env.TANDEM_DEV_PASSWORD || crypto.randomUUID();
const totp = process.env.TANDEM_DEV_TOTP === '1';
const port = Number(process.env.PORT || 8791);
const sessions = new Map<string, { created: number; last: number }>();
const failures = new Map<string, { count: number; until: number }>();
const sockets = new Set<ServerWebSocket<SocketData>>();
const audit: Record<string, unknown>[] = [];
const observed: Message[] = [];
let counter = 3, seq = 0, agentTick = 0;
let tabs: RemoteTab[] = scene.tabs ?? [
  { targetId: 'tab-1', url: 'https://en.wikipedia.org/wiki/Tandem_bicycle', title: 'Tandem bicycle — Wikipedia', loading: false, canGoBack: true, canGoForward: false, opener: 'agent', lastAgentActivityAt: Date.now() },
  { targetId: 'tab-2', url: 'https://example.com/research', title: 'Research notes', loading: false, canGoBack: false, canGoForward: false, opener: 'agent' },
  { targetId: 'tab-3', url: 'https://example.com/', title: 'A little space to explore', loading: false, canGoBack: false, canGoForward: false, opener: 'human' },
];
let activeTargetId = scene.activeTargetId ?? 'tab-1';
let control: Control = { controller: 'agent', since: Date.now(), yours: false, agentBusy: false, pendingAgentCalls: 0 };
let dialog: RemoteDialog | undefined;
interface SocketData { sessionId: string; viewed: string; hello: boolean }
function record(event: string) { audit.push({ ts: new Date().toISOString(), actor: 'human', event }); }
function controlFor(sessionId: string) { return { ...control, yours: control.controller === 'human' && control.holderSessionId === sessionId }; }
function emit(ws: ServerWebSocket<SocketData>, data: unknown) { ws.send(JSON.stringify(data)); }
function broadcast(data: unknown) { for (const ws of sockets) emit(ws, data); }
function updateControl() { for (const ws of sockets) emit(ws, { t: 'control', ...controlFor(ws.data.sessionId) }); }
function updateTabs() { broadcast({ t: 'tabs', tabs, activeTargetId }); }
function frame(ws: ServerWebSocket<SocketData>) {
  if (!ws.data.hello || ws.getBufferedAmount() > 2e6 || !tabs.some(t => t.targetId === ws.data.viewed)) return;
  const header = new TextEncoder().encode(JSON.stringify({ targetId: ws.data.viewed, seq: ++seq, deviceWidth: scene.width ?? 1600, deviceHeight: scene.height ?? 913, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0, timestamp: Date.now() / 1000, format: 'jpeg' }));
  const bytes = new Uint8Array(4 + header.length + jpeg.length);
  new DataView(bytes.buffer).setUint32(0, header.length, false); bytes.set(header, 4); bytes.set(jpeg, 4 + header.length); ws.send(bytes);
}
function validSession(request: Request) {
  const id = /(?:^|;\s*)tandem_session=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
  const session = id ? sessions.get(id) : undefined;
  if (!session || Date.now() - session.created > 72 * 3600000 || Date.now() - session.last > 12 * 3600000) return;
  session.last = Date.now(); return id;
}
const server = Bun.serve<SocketData>({
  hostname: '127.0.0.1', port,
  async fetch(request, server) {
    const url = new URL(request.url), path = url.pathname;
    const origin = url.origin;
    const headers: Record<string, string> = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      ...(path.startsWith('/api/') ? { 'Cache-Control': 'no-store' } : {}),
    };
    const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => Response.json(data, { status, headers: { ...headers, ...extra } });
    if ((request.method !== 'GET' || path === '/ws') && request.headers.get('origin') !== origin) return json({ error: 'bad_origin' }, 403);
    if (request.method !== 'GET' && request.headers.get('x-tandem') !== '1') return json({ error: 'missing_tandem_header' }, 403);
    if (path === '/api/auth-config') return json({ totp, productName: brand.productName });
    if (path === '/api/health') return json({ ok: true, cdp: true, mcp: true, version: 'dev-mock' });
    if (path === '/api/login' && request.method === 'POST') {
      const ip = server.requestIP(request)?.address || 'local';
      const failure = failures.get(ip);
      if (failure && failure.until > Date.now() && failure.count >= 5) {
        const retryAfter = Math.ceil((failure.until - Date.now()) / 1000);
        return json({ error: 'rate_limited', retryAfter }, 429, { 'Retry-After': String(retryAfter) });
      }
      let body: { password?: string; totp?: string };
      try { body = await request.json(); } catch { return json({ error: 'invalid_credentials' }, 401); }
      if (!body || body.password !== password || (totp && body.totp !== '123456')) {
        const next = failure && failure.until > Date.now() ? failure : { count: 0, until: Date.now() + 900000 };
        next.count++; failures.set(ip, next); record('login.fail'); return json({ error: 'invalid_credentials' }, 401);
      }
      failures.delete(ip); const id = crypto.randomUUID(); sessions.set(id, { created: Date.now(), last: Date.now() }); record('login.ok');
      return json({ ok: true }, 200, { 'Set-Cookie': `tandem_session=${id}; HttpOnly; SameSite=Strict; Path=/` });
    }
    const publicPath = path === '/login' || path === '/login.html' || path.startsWith('/assets/') || path === '/brand.json' || path === '/favicon.svg';
    const sessionId = validSession(request);
    if (!publicPath && !sessionId) {
      if (path.startsWith('/api/') || path === '/ws') return json({ error: 'unauthorized' }, 401);
      return new Response(null, { status: 302, headers: { ...headers, Location: '/login' } });
    }
    if (path === '/api/me') return json({ user: 'owner', sessionId, expiresAt: new Date(Date.now() + 12 * 3600000).toISOString(), totp });
    if (path === '/api/logout' && request.method === 'POST') {
      sessions.delete(sessionId!); record('logout');
      if (control.holderSessionId === sessionId) { control = { controller: 'agent', yours: false, since: Date.now(), agentBusy: false, pendingAgentCalls: 0 }; updateControl(); }
      for (const ws of sockets) if (ws.data.sessionId === sessionId) ws.close(4401, 'Logged out');
      return json({ ok: true }, 200, { 'Set-Cookie': 'tandem_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (path === '/api/audit') return json(audit.slice(-Math.min(200, Number(url.searchParams.get('limit')) || 200)));
    if (path === '/api/mock/messages') return json(observed);
    if (path === '/api/mock/dialog' && request.method === 'POST') {
      const body = await request.json() as Partial<RemoteDialog>;
      dialog = { targetId: activeTargetId, type: body.type || 'prompt', message: 'A demonstration JavaScript dialog from the remote page.', defaultPrompt: 'Hello from your browser' };
      broadcast({ t: 'dialog', ...dialog }); return json({ ok: true });
    }
    if (path === '/api/mock/disconnect' && request.method === 'POST') { for (const ws of sockets) ws.close(1012, 'Mock reconnect test'); return json({ ok: true }); }
    if (path === '/ws') {
      if (server.upgrade(request, { data: { sessionId: sessionId!, viewed: activeTargetId, hello: false }, headers })) return;
      return json({ error: 'upgrade_failed' }, 400);
    }
    if (path.startsWith('/desktop/')) return new Response('Dev mock: the raw desktop is available only with the real engine.', { headers });
    const relative = path === '/' ? 'index.html' : path === '/login' ? 'login.html' : decodeURIComponent(path.slice(1));
    const filePath = resolve(dist, relative);
    if (!filePath.startsWith(dist + sep)) return json({ error: 'not_found' }, 404);
    const file = Bun.file(filePath);
    return await file.exists() ? new Response(file, { headers }) : json({ error: 'not_found' }, 404);
  },
  websocket: {
    open(ws) { sockets.add(ws); },
    message(ws, raw) {
      const session = sessions.get(ws.data.sessionId);
      if (!session || Date.now() - session.created > 72 * 3600000 || Date.now() - session.last > 12 * 3600000) { ws.close(4401); return; }
      session.last = Date.now();
      let message: Message;
      try { message = JSON.parse(String(raw)); } catch { ws.close(4403); return; }
      if (!ws.data.hello && message.t !== 'hello') { ws.close(4403); return; }
      const allowed = ['hello', 'viewport', 'view', 'follow', 'control.take', 'control.release', 'ping'];
      if (!allowed.includes(message.t) && !controlFor(ws.data.sessionId).yours) { emit(ws, { t: 'error', code: 'not_in_control', message: 'Take manual control first.' }); return; }
      // In-memory diagnostics omit private typed/clipboard content.
      observed.push({ ...message, ...(message.t === 'input.text' ? { text: '[redacted]' } : {}), ...(message.t === 'input.key' && message.text ? { text: '[redacted]' } : {}) });
      if (observed.length > 2000) observed.shift();
      const target = tabs.find(t => t.targetId === message.targetId);
      switch (message.t) {
        case 'hello': ws.data.hello = true; emit(ws, { t: 'welcome', sessionId: ws.data.sessionId, brand, control: controlFor(ws.data.sessionId), tabs, activeTargetId, serverVersion: 'dev-mock' }); if (dialog) emit(ws, { t: 'dialog', ...dialog }); frame(ws); break;
        case 'viewport': case 'follow': break;
        case 'view': if (target) { ws.data.viewed = target.targetId; frame(ws); } break;
        case 'control.take': control = { controller: 'human', holderSessionId: ws.data.sessionId, holderLabel: 'You', since: Date.now(), yours: true, agentBusy: false, pendingAgentCalls: scene.pendingAgentCalls ?? 2 }; record('control.take'); updateControl(); break;
        case 'control.release': if (controlFor(ws.data.sessionId).yours) { control = { controller: 'agent', since: Date.now(), yours: false, agentBusy: false, pendingAgentCalls: 0 }; record('control.release'); updateControl(); } break;
        case 'tab.activate': if (target) { activeTargetId = target.targetId; ws.data.viewed = target.targetId; updateTabs(); frame(ws); } break;
        case 'tab.new': {
          const item: RemoteTab = { targetId: `tab-${++counter}`, url: String(message.url || 'about:blank'), title: 'New tab', opener: 'human', loading: false, canGoBack: false, canGoForward: false };
          tabs.push(item); activeTargetId = item.targetId; ws.data.viewed = item.targetId; updateTabs(); frame(ws); break;
        }
        case 'tab.close': tabs = tabs.filter(t => t.targetId !== message.targetId); if (activeTargetId === message.targetId) activeTargetId = tabs[0]?.targetId || ''; updateTabs(); break;
        case 'nav.go': if (target) {
          let url = String(message.url || '').trim();
          if (/^(javascript:|file:|data:|chrome:(?!\/\/newtab\/?$))/i.test(url)) { emit(ws, { t: 'error', code: 'invalid_url', message: 'This URL is not allowed.' }); break; }
          if (!/^(https?:|about:blank|chrome:\/\/newtab)/.test(url)) url = /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
          target.url = url; target.title = url === 'about:blank' ? 'New tab' : 'Your page'; target.loading = true; target.canGoBack = true; updateTabs();
          setTimeout(() => { target.loading = false; updateTabs(); }, 600);
        } break;
        case 'nav.reload': if (target) { target.loading = true; updateTabs(); setTimeout(() => { target.loading = false; updateTabs(); }, 600); } break;
        case 'nav.stop': if (target) { target.loading = false; updateTabs(); } break;
        case 'clipboard.copy': emit(ws, { t: 'clipboard', reqId: message.reqId, text: 'A selection from the shared browser' }); break;
        case 'dialog.respond': if (dialog && dialog.targetId === message.targetId) { broadcast({ t: 'dialog.closed', targetId: dialog.targetId }); dialog = undefined; } break;
        case 'ping': emit(ws, { t: 'pong', ts: message.ts, serverTs: Date.now() }); break;
      }
    },
    close(ws) {
      sockets.delete(ws);
      if (control.holderSessionId === ws.data.sessionId) setTimeout(() => {
        if (control.holderSessionId === ws.data.sessionId && ![...sockets].some(s => s.data.sessionId === ws.data.sessionId)) { control = { controller: 'agent', yours: false, since: Date.now(), agentBusy: false, pendingAgentCalls: 0 }; updateControl(); }
      }, 60000).unref();
    },
  },
});
setInterval(() => {
  for (const ws of sockets) {
    if (!sessions.has(ws.data.sessionId)) ws.close(4401); else frame(ws);
  }
}, 500).unref();
setInterval(() => {
  if (scene.autoActivity === false || control.controller !== 'agent' || !tabs.length) return;
  const target = tabs[agentTick++ % Math.min(tabs.length, 2)]; activeTargetId = target.targetId; target.lastAgentActivityAt = Date.now(); updateTabs();
  broadcast({ t: 'agent.activity', tool: 'browser_get_page_content', targetId: target.targetId, at: Date.now() });
}, 4500).unref();
console.log(`Mock viewer: http://127.0.0.1:${server.port}\nDev password: ${password}${totp ? '\nDev TOTP: 123456' : ''}\nTrigger a JS dialog with POST /api/mock/dialog (session, Origin and X-Tandem: 1 required).`);
