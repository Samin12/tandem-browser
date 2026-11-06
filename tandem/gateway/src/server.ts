import type { Server, ServerWebSocket } from 'bun';
import { readdirSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { Config } from './config';
import { Sessions, sessionCookie, type Session } from './auth';
import { Audit, log } from './audit';
import { checkOrigin, clientIp, constantEqual, RateLimit, securityHeaders, verifyTotp } from './security';
import { Control } from './control';
import { Cdp } from './cdp';
import { Screencasts } from './screencast';
import { copySelection, inputCommand } from './input';
import { McpProxy } from './mcp';
import { parkPointer } from './pointer';
import { RfbFilter, CUT_TEXT_LIMIT } from './rfb';
import { Follow } from './follow';
import { AgentCdpProxy, agentAuthorized, cdpRoute, CDP_BYTES, type AgentCdpConnection } from './agent-cdp';
import { Neko, nekoRoute } from './neko';

export const VERSION = '0.1.0';
export function webFingerprint(root: string) {
  const hash = createHash('sha256');
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' }).sort()) {
    const path = resolve(root, name);
    if (statSync(path).isFile()) hash.update(name).update('\0').update(readFileSync(path));
  }
  return hash.digest('hex').slice(0, 16);
}
interface SocketData { kind: 'viewer' | 'desktop' | 'neko' | 'cdp'; sessionId: string; agentCdp?: AgentCdpConnection; cdpPath?: string; hello: boolean; viewport: { w: number; h: number; dpr: number }; targetId?: string; upstream?: WebSocket; rfb?: RfbFilter; queue: Promise<void>; openedAt: number }
type Socket = ServerWebSocket<SocketData>;
class NotInControl extends Error {}
export function createGateway(config: Config) {
  const sessions = new Sessions(config), audit = new Audit(config.dataDir), control = new Control(config.dataDir, audit);
  const cdp = new Cdp(config.cdpUrl, () => control.controller === 'agent'), screencasts = new Screencasts(cdp);
  const mcp = new McpProxy(config, control, audit, cdp), limiter = new RateLimit();
  const viewers = new Set<Socket>(), desktops = new Set<Socket>(), follow = new Follow(cdp, control);
  const neko = new Neko(config, sessions, control);
  const agentCdp = new AgentCdpProxy(config, control, audit, cdp);
  const loginQueues = new Map<string, Promise<void>>();
  let brand: Record<string, unknown>;
  try { brand = JSON.parse(readFileSync(config.brandFile, 'utf8')); if (!brand || typeof brand !== 'object' || Array.isArray(brand)) throw 0; }
  catch { throw new Error('TANDEM_BRAND_FILE: a readable JSON object is required'); }
  let publicRoot: string;
  try { publicRoot = realpathSync(config.publicDir); if (!statSync(publicRoot).isDirectory()) throw 0; } catch { throw new Error('TANDEM_PUBLIC_DIR: a readable directory is required'); }
  // Fingerprint of the viewer files; open viewers reload when a deploy changes it.
  const webBuild = webFingerprint(publicRoot);
  const send = (ws: Socket, value: unknown) => { if (ws.readyState === 1) ws.send(JSON.stringify(value)); };
  const broadcast = (value: unknown) => { for (const ws of viewers) send(ws, value); };
  const tabs = () => ({ t: 'tabs', tabs: [...cdp.tabs.values()], activeTargetId: cdp.activeTargetId ?? null });
  let tabsTimer: ReturnType<typeof setTimeout> | undefined;
  cdp.on('tabs', () => { if (!tabsTimer) tabsTimer = setTimeout(() => { tabsTimer = undefined; broadcast(tabs()); }, 25); });
  cdp.on('activity', value => { follow.activity(value.targetId); broadcast(tabs()); broadcast({ ...value, tool: control.lastAgentTool?.name ?? value.tool }); });
  cdp.on('dialog', value => broadcast(value));
  let lastController = control.controller;
  control.onChange = () => {
    for (const ws of viewers) send(ws, { t: 'control', ...control.state(ws.data.sessionId) });
    follow.changed(); neko.changed();
    // A person just handed back: park the X pointer so watchers don't see a frozen arrow.
    if (lastController === 'human' && control.controller === 'agent') void parkPointer();
    lastController = control.controller;
  };
  sessions.onRevoke = id => {
    neko.revoke(id);
    for (const ws of [...viewers, ...desktops]) if (ws.data.sessionId === id) { follow.set(ws, false); ws.close(4401, 'Session expired'); }
    control.release(id);
  };
  const fail = (error: string, status: number, extra: Record<string, unknown> = {}) => Response.json({ error, ...extra }, { status });
  const secureResponse = (path: string, response: Response) => {
    const headers = new Headers(response.headers);
    for (const [key, value] of securityHeaders(path)) headers.set(key, value);
    if (path === '/cdp' || path.startsWith('/cdp/')) headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  };
  const requireSession = (req: Request) => req.headers.has('authorization') ? null : sessions.fromRequest(req);
  async function staticFile(path: string, session: Session | null) {
    const publicRoute = path === '/login' || path === '/login.html' || path.startsWith('/assets/') || path === '/favicon.svg';
    if (!publicRoute && !session) return Response.redirect(`${config.origins[0]}/login`, 302);
    let decoded: string;
    try { decoded = decodeURIComponent(path); } catch { return fail('invalid_path', 400); }
    if (decoded.includes('\0') || decoded.includes('\\')) return fail('invalid_path', 400);
    const root = publicRoot;
    const requested = path === '/login' ? 'login.html' : path === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    let filePath = resolve(root, requested);
    if (!filePath.startsWith(root + sep) || (path.startsWith('/assets/') && !filePath.startsWith(resolve(root, 'assets') + sep))) return fail('not_found', 404);
    let file = Bun.file(filePath);
    if (!await file.exists()) {
      if (publicRoute || path.includes('.')) return fail('not_found', 404);
      filePath = resolve(root, 'index.html'); file = Bun.file(filePath);
    }
    try { const actual = realpathSync(filePath); if (!actual.startsWith(root + sep) || (path.startsWith('/assets/') && !actual.startsWith(resolve(root, 'assets') + sep))) return fail('not_found', 404); } catch { return fail('not_found', 404); }
    // Viewer files keep fixed names, so browsers must revalidate them after a deploy.
    return new Response(file, { headers: { 'cache-control': 'no-cache' } });
  }
  async function route(req: Request, server: Server<SocketData>, privateListener: boolean): Promise<Response | undefined> {
    const url = new URL(req.url), path = url.pathname;
    if (config.viewerAuth === 'tailscale' && !privateListener && path !== '/mcp' && path !== '/cdp' && !path.startsWith('/cdp/') && !(path === '/api/health' && req.method === 'GET')) return fail('not_found', 404);
    if (path === '/cdp' || path.startsWith('/cdp/')) {
      if (!config.agentCdp) return fail('not_found', 404);
      const target = cdpRoute(path);
      if (!agentAuthorized(req, config.agentToken, target?.token)) return fail('unauthorized', 401);
      if (!target || req.method !== 'GET') return fail('not_found', 404);
      if (!target.socket) return agentCdp.discovery(target.path, target.token, config.viewerAuth === 'tailscale' && !privateListener ? config.origins[1] : undefined);
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail('not_found', 404);
      if (!agentCdp.reserve()) return fail('too_many_connections', 429);
      let upstream: WebSocket;
      try { upstream = await agentCdp.socket(target.path); }
      catch { agentCdp.release(); return fail('upstream_unavailable', 502); }
      if (server.upgrade(req, { headers: securityHeaders(path), data: { kind: 'cdp', sessionId: '', upstream, cdpPath: target.path,
        hello: false, viewport: { w: 0, h: 0, dpr: 1 }, queue: Promise.resolve(), openedAt: Date.now() } })) return;
      upstream.close(); agentCdp.release(); return fail('upgrade_failed', 400);
    }
    if (path === '/mcp') {
      const header = req.headers.get('authorization') ?? '';
      if (!header.startsWith('Bearer ') || !constantEqual(header.slice(7), config.agentToken)) return fail('unauthorized', 401);
      server.timeout(req, 0);
      return mcp.handle(req);
    }
    if (config.viewerAuth === 'tailscale' && path === '/api/login' && req.method === 'POST') return fail('not_found', 404);
    const tailscaleUser = req.headers.get('tailscale-user-login')?.trim() ?? '';
    if (config.viewerAuth === 'tailscale' && !(path === '/api/health' && req.method === 'GET') && (!tailscaleUser || (config.tailscaleUsers.length && !config.tailscaleUsers.includes(tailscaleUser.toLowerCase())))) return fail('tailscale_required', 403);
    if (!checkOrigin(req, config.origins, path === '/ws' || path === '/desktop/websockify' || path === '/neko/api/ws')
      || (path.startsWith('/neko/') && req.headers.has('origin') && !config.origins.includes(req.headers.get('origin')!))) return fail('forbidden_origin', 403);
    if (path === '/api/health' && req.method === 'GET') return Response.json({ ok: cdp.connected && mcp.healthy, cdp: cdp.connected, mcp: mcp.healthy, neko: await neko.health(), version: VERSION });
    // A bearer credential is intentionally never a viewer credential, even alongside a cookie.
    if (req.headers.has('authorization')) return fail('unauthorized', 401);
    if (config.viewerAuth === 'tailscale' && (path === '/login' || path === '/login.html') && req.method === 'GET') {
      if (sessions.fromRequest(req)) return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
      const { token, session } = sessions.create();
      audit.write('human', 'login.ok', { via: 'tailscale', user: tailscaleUser }, { sessionId: session.id });
      return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store', 'set-cookie': sessionCookie(token, config, config.origins[0]!) } });
    }
    if (path === '/api/auth-config' && req.method === 'GET') return Response.json({ mode: config.viewerAuth, totp: !!config.totpSecret, productName: brand.productName ?? 'Tandem Browser' });
    if (path === '/api/login' && req.method === 'POST') {
      if (!req.headers.get('content-type')?.startsWith('application/json')) return fail('json_required', 415);
      const ip = clientIp(req, server.requestIP(req)?.address ?? 'unknown');
      let body: any;
      try { body = await req.json(); } catch { return fail('invalid_json', 400); }
      const previous = loginQueues.get(ip) ?? Promise.resolve();
      const result = previous.then(async () => {
        const retryAfter = limiter.retryAfter(ip);
        if (retryAfter) { const response = fail('rate_limited', 429, { retryAfter }); response.headers.set('retry-after', String(retryAfter)); return response; }
        const password = typeof body?.password === 'string' && body.password.length <= 10000 ? body.password : '';
        const passwordOk = await Bun.password.verify(password, config.passwordHash);
        const totpOk = !config.totpSecret || verifyTotp(config.totpSecret, body?.totp);
        if (!passwordOk || !totpOk) { limiter.fail(ip); audit.write('human', 'login.fail', {}, { ip }); return fail('invalid_credentials', 401); }
        limiter.clear(ip);
        const { token, session } = sessions.create();
        audit.write('human', 'login.ok', {}, { ip, sessionId: session.id });
        return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie(token, config, req.headers.get('origin')!) } });
      });
      const settled = result.then(() => {}, () => {});
      loginQueues.set(ip, settled);
      try { return await result; }
      finally { if (loginQueues.get(ip) === settled) loginQueues.delete(ip); }
    }
    if (path === '/brand.json' && req.method === 'GET') return Response.json(brand);
    const session = requireSession(req);
    if (path.startsWith('/neko/')) {
      if (!session) return fail('unauthorized', 401);
      const target = path.slice('/neko'.length);
      if (!neko.enabled || !nekoRoute(req.method, target)) return fail('not_found', 404);
      if (target !== '/api/ws') return neko.proxy(session.id, target);
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail('upgrade_required', 426);
      let upstream: WebSocket;
      try { upstream = await neko.socket(session.id); } catch { return fail('neko_unavailable', 502); }
      if (!sessions.byId(session.id)) { upstream.close(); return fail('unauthorized', 401); }
      if (server.upgrade(req, { headers: securityHeaders(path), data: { kind: 'neko', sessionId: session.id, upstream, hello: false,
        viewport: { w: 1600, h: 1000, dpr: 1 }, queue: Promise.resolve(), openedAt: Date.now() } })) return undefined;
      upstream.close(); return fail('upgrade_failed', 400);
    }
    if (path === '/ws' || path === '/desktop/websockify') {
      if (!session) return fail('unauthorized', 401);
      if (req.method !== 'GET' || req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail('upgrade_required', 426);
      const desktop = path === '/desktop/websockify';
      const protocols = desktop ? (req.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim()) : [];
      const headers = securityHeaders(path);
      if (protocols.includes('binary')) headers.set('sec-websocket-protocol', 'binary');
      if (server.upgrade(req, { headers, data: { kind: desktop ? 'desktop' : 'viewer', sessionId: session.id, hello: false,
        viewport: { w: 1600, h: 1000, dpr: 1 }, queue: Promise.resolve(), openedAt: Date.now() } })) return undefined;
      return fail('upgrade_failed', 400);
    }
    if (path.startsWith('/api/')) {
      if (!session) return fail('unauthorized', 401);
      if (path === '/api/me' && req.method === 'GET') return Response.json({ user: 'owner', sessionId: session.id, expiresAt: session.expiresAt, totp: !!config.totpSecret, displayScale: config.displayScale, webrtc: await neko.health() });
      if (path === '/api/audit' && req.method === 'GET') return Response.json(audit.tail(Number(url.searchParams.get('limit')) || 200));
      if (path === '/api/logout' && req.method === 'POST') {
        sessions.revoke(session.id); audit.write('human', 'logout', {}, { sessionId: session.id });
        return Response.json({ ok: true }, { headers: { 'set-cookie': sessionCookie('', config, req.headers.get('origin')!, true) } });
      }
      return fail('not_found', 404);
    }
    if (path.startsWith('/desktop/')) {
      if (!session) return fail('unauthorized', 401);
      if (req.method !== 'GET') return fail('method_not_allowed', 405);
      if (path === '/desktop/') return new Response(null, { status: 302, headers: { location: '/desktop/vnc.html?path=desktop/websockify&autoconnect=1&resize=remote&reconnect=1' } });
      const target = new URL(config.novncUrl); target.pathname = path.slice('/desktop'.length); target.search = url.search;
      try {
        const upstream = await fetch(target, { headers: { accept: req.headers.get('accept') ?? '*/*' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const headers = new Headers();
        for (const name of ['content-type']) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
        if (upstream.headers.has('location')) {
          const location = new URL(upstream.headers.get('location')!, target);
          if (location.origin === target.origin) headers.set('location', `/desktop${location.pathname}${location.search}`);
        }
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch { return fail('desktop_unavailable', 502); }
    }
    if (req.method !== 'GET') return fail('method_not_allowed', 405);
    return staticFile(path, session);
  }
  function viewport(m: any) {
    if (![m.w, m.h, m.dpr].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0) || m.w > 10000 || m.h > 10000 || m.dpr > 8) throw new Error('Invalid viewport');
    return { w: m.w as number, h: m.h as number, dpr: m.dpr as number };
  }
  async function message(ws: Socket, raw: string | Buffer) {
    if (!sessions.byId(ws.data.sessionId, true)) { ws.close(4401, 'Session expired'); return; }
    if (ws.data.kind === 'desktop') {
      if (typeof raw === 'string') { ws.close(4403, 'Expected RFB bytes'); return; }
      ws.data.rfb!.push(raw);
      return;
    }
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024) { ws.close(4403, 'Expected JSON'); return; }
    let m: any;
    try { m = JSON.parse(raw); } catch { ws.close(4403, 'Invalid JSON'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') { ws.close(4403, 'Invalid message'); return; }
    if (!ws.data.hello && m.t !== 'hello') { ws.close(4403, 'hello required'); return; }
    try {
      if (m.t === 'hello') { if (ws.data.hello) throw new Error('Duplicate hello'); ws.data.viewport = viewport(m.viewport); ws.data.hello = true; return; }
      if (m.t === 'screen') { neko.screen(ws.data.sessionId, m.w, m.h); return; }
      if (m.t === 'follow') { if (typeof m.enabled !== 'boolean') throw new Error('Invalid follow'); follow.set(ws, m.enabled); return; }
      if (m.t === 'viewport') { ws.data.viewport = viewport(m); screencasts.viewport(ws, ws.data.viewport); return; }
      if (m.t === 'ping') { send(ws, { t: 'pong', ts: m.ts, serverTs: Date.now() }); return; }
      if (m.t === 'control.take') { control.take(ws.data.sessionId); return; }
      if (m.t === 'view') { if (typeof m.targetId !== 'string') throw new Error('Invalid target'); screencasts.subscribe(m.targetId, ws, ws.data.viewport); ws.data.targetId = m.targetId; return; }
      const commands = ['control.release', 'tab.new', 'tab.close', 'tab.activate', 'nav.go', 'nav.back', 'nav.forward', 'nav.reload', 'nav.stop', 'input.mouse', 'input.key', 'input.text', 'clipboard.copy', 'dialog.respond'];
      if (!commands.includes(m.t)) { ws.close(4403, 'Unknown command'); return; }
      if (!control.holds(ws.data.sessionId)) { send(ws, { t: 'error', code: 'not_in_control', message: 'Take manual control to interact with the browser', reqId: m.reqId }); return; }
      if (m.t === 'control.release') { control.release(ws.data.sessionId); return; }
      const guard = () => { if (!control.holds(ws.data.sessionId) || !sessions.byId(ws.data.sessionId)) throw new NotInControl(); };
      const humanPage = (targetId: string, method: string, params: Record<string, unknown> = {}) => cdp.page(targetId, method, params, guard);
      const context = { sessionId: ws.data.sessionId };
      if (m.t === 'tab.new') {
        if (m.url !== undefined && typeof m.url !== 'string') throw new Error('Invalid URL');
        const { targetId, url } = await cdp.newTab(m.url, guard);
        audit.write('human', 'tab.new', { targetId, origin: url }, context); return;
      }
      if (typeof m.targetId !== 'string' || !cdp.tabs.has(m.targetId)) throw new Error('Unknown tab');
      if (m.t === 'tab.close') { await cdp.send('Target.closeTarget', { targetId: m.targetId }); audit.write('human', m.t, { targetId: m.targetId }, context); }
      else if (m.t === 'tab.activate') { await cdp.activate(m.targetId, guard); screencasts.subscribe(m.targetId, ws, ws.data.viewport); ws.data.targetId = m.targetId; audit.write('human', m.t, { targetId: m.targetId }, context); }
      else if (m.t === 'nav.go') { if (typeof m.url !== 'string') throw new Error('Invalid URL'); const url = await cdp.navigate(m.targetId, m.url, guard); audit.write('human', m.t, { targetId: m.targetId, origin: url }, context); }
      else if (m.t === 'nav.back' || m.t === 'nav.forward') await cdp.moveHistory(m.targetId, m.t === 'nav.back' ? -1 : 1, guard);
      else if (m.t === 'nav.reload') await humanPage(m.targetId, 'Page.reload');
      else if (m.t === 'nav.stop') await humanPage(m.targetId, 'Page.stopLoading');
      else if (m.t.startsWith('input.')) { const { method, params } = inputCommand(m); await humanPage(m.targetId, method, params); }
      else if (m.t === 'clipboard.copy') {
        if (typeof m.reqId !== 'string' || m.reqId.length > 200) throw new Error('Invalid request ID');
        send(ws, { t: 'clipboard', reqId: m.reqId, text: await copySelection(cdp, m.targetId) });
      } else if (m.t === 'dialog.respond') {
        if (typeof m.accept !== 'boolean' || (m.promptText !== undefined && (typeof m.promptText !== 'string' || m.promptText.length > 100000))) throw new Error('Invalid dialog response');
        await humanPage(m.targetId, 'Page.handleJavaScriptDialog', { accept: m.accept, ...(m.promptText !== undefined ? { promptText: m.promptText } : {}) });
      }
    } catch (error) {
      send(ws, { t: 'error', code: error instanceof NotInControl ? 'not_in_control' : 'command_failed', message: 'Invalid command or browser unavailable', reqId: typeof m.reqId === 'string' ? m.reqId : undefined });
    }
  }
  const listen = (hostname: string, port: number, privateListener = false) => Bun.serve<SocketData>({
    hostname, port, maxRequestBodySize: 2 * 1024 * 1024, idleTimeout: 255,
    fetch: async (req, srv) => {
      const path = new URL(req.url).pathname;
      try { const response = await route(req, srv, privateListener); return response ? secureResponse(path, response) : undefined; }
      catch { log('request.failed', { method: req.method }); return secureResponse(path, fail('internal_error', 500)); }
    },
    websocket: {
      maxPayloadLength: Math.max(CUT_TEXT_LIMIT, CDP_BYTES), idleTimeout: 120, backpressureLimit: CDP_BYTES, closeOnBackpressureLimit: false,
      open(ws) {
        if (ws.data.kind === 'cdp') { agentCdp.attach(ws, ws.data.cdpPath!); return; }
        control.connected(ws.data.sessionId);
        if (ws.data.kind === 'neko') { neko.attach(ws); return; }
        if (ws.data.kind === 'viewer') {
          viewers.add(ws);
          send(ws, { t: 'welcome', sessionId: ws.data.sessionId, brand, control: control.state(ws.data.sessionId), tabs: [...cdp.tabs.values()], activeTargetId: cdp.activeTargetId ?? null, serverVersion: VERSION, build: webBuild });
        } else {
          desktops.add(ws); audit.write('human', 'desktop.open', {}, { sessionId: ws.data.sessionId });
          const target = new URL('/websockify', config.novncUrl); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
          const upstream = new WebSocket(target, ['binary']); ws.data.upstream = upstream; upstream.binaryType = 'arraybuffer';
          ws.data.rfb = new RfbFilter(() => control.holds(ws.data.sessionId), bytes => {
            if (upstream.readyState !== WebSocket.OPEN) { ws.close(1013, 'Desktop connecting'); return; }
            if (upstream.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'Desktop backpressure'); return; }
            upstream.send(bytes);
          }, (reason, type) => { log('desktop.protocol_violation', { reason, type: type ?? -1 }); ws.close(4403, reason); });
          upstream.onmessage = event => {
            if (!sessions.byId(ws.data.sessionId)) { ws.close(4401, 'Session expired'); return; }
            if (ws.readyState !== 1) return;
            if (ws.getBufferedAmount() > 2 * 1024 * 1024) { ws.close(1013, 'Desktop backpressure'); return; }
            if (typeof event.data === 'string') ws.send(event.data); else ws.send(new Uint8Array(event.data));
          };
          upstream.onerror = () => ws.close(1011, 'Desktop unavailable');
          upstream.onclose = () => ws.close(1000, 'Desktop closed');
        }
      },
      message(ws, data) {
        // The socket limit is sized for CDP screenshots; every other socket keeps the cut-text limit.
        if (ws.data.kind !== 'cdp' && Buffer.byteLength(data) > CUT_TEXT_LIMIT) { ws.close(1009, 'Message too big'); return; }
        if (ws.data.kind === 'cdp') {
          if (typeof data !== 'string') ws.close(4403, 'Expected CDP JSON'); else ws.data.agentCdp!.message(data);
          return;
        }
        if (ws.data.kind === 'neko') { neko.message(ws, data); return; }
        if (ws.data.kind === 'desktop') { void message(ws, data).catch(() => ws.close(4403, 'Protocol violation')); return; }
        // Control transitions must not wait behind an outstanding browser command.
        if (ws.data.kind === 'viewer' && typeof data === 'string') {
          try {
            const m = JSON.parse(data);
            if (ws.data.hello && (m?.t === 'control.take' || m?.t === 'control.release')) { void message(ws, data); return; }
          } catch {}
        }
        ws.data.queue = ws.data.queue.then(() => message(ws, data)).catch(() => ws.close(4403, 'Protocol violation'));
      },
      close(ws) { if (ws.data.kind === 'cdp') { agentCdp.detach(ws); return; } if (ws.data.kind === 'neko') neko.detach(ws); follow.set(ws, false); viewers.delete(ws); desktops.delete(ws); screencasts.unsubscribe(ws); ws.data.upstream?.close(); control.disconnected(ws.data.sessionId); },
    },
  });
  const server = listen(config.hostname, config.port);
  const privateServer = config.viewerAuth === 'tailscale' ? listen(config.privateListen!.hostname, config.privateListen!.port, true) : undefined;
  const timer = setInterval(() => {
    sessions.sweep(); limiter.sweep(); neko.sweep();
    for (const ws of [...viewers, ...desktops]) {
      if (!sessions.byId(ws.data.sessionId)) ws.close(4401, 'Session expired');
      else if (ws.data.kind === 'viewer' && !ws.data.hello && Date.now() - ws.data.openedAt > 10000) ws.close(4403, 'hello required');
    }
  }, 1000);
  cdp.start(); mcp.start(); neko.start(); log('gateway.started', { port: server.port! });
  if (control.controller === 'agent') void parkPointer();
  return { server, privateServer, sessions, control, cdp, mcp, audit, neko, async close() {
    clearInterval(timer); clearTimeout(tabsTimer); follow.close(); agentCdp.close(); mcp.close(); screencasts.close(); cdp.close();
    await neko.close();
    for (const ws of [...viewers, ...desktops]) ws.terminate();
    // Bun 1.3 can leave stop() pending after a completed WebSocket close handshake.
    for (const listener of [server, privateServer]) if (listener) { void listener.stop(true); listener.unref(); }
    control.close(); sessions.close(); audit.close();
  } };
}
