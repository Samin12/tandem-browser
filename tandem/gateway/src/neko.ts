import type { ServerWebSocket } from 'bun';
import type { Config } from './config';
import type { Sessions } from './auth';
import type { Control } from './control';
import { log } from './audit';

interface NekoSession { id: string; token: string }
export interface NekoSocketData { sessionId: string; upstream?: WebSocket }
type Socket = ServerWebSocket<NekoSocketData>;
const READ_ROUTES = new Set(['/api/whoami']);
export function nekoRoute(method: string, path: string) { return method === 'GET' && (READ_ROUTES.has(path) || path === '/api/ws'); }
export function screenSize(w: unknown, h: unknown): w is number {
  return typeof w === 'number' && typeof h === 'number' && Number.isInteger(w) && Number.isInteger(h) && !(w % 2) && !(h % 2)
    && w >= 320 && w <= 3840 && h >= 240 && h <= 2400 && w * h <= 3840 * 2400;
}
export class Neko {
  private cache = new Map<string, NekoSession>();
  private logins = new Map<string, Promise<NekoSession>>();
  private deletions = new Set<string>();
  private pendingFrames = new WeakMap<WebSocket, (string | ArrayBuffer)[]>();
  private sockets = new Set<Socket>();
  private timer?: ReturnType<typeof setInterval>;
  private screenTimer?: ReturnType<typeof setTimeout>;
  private screenQueue = Promise.resolve();
  private controlQueue = Promise.resolve();
  private probe?: Promise<boolean>;
  private ready = false;
  private stopped = false;
  constructor(private config: Config, private sessions: Sessions, private control: Control) {}
  get enabled() { return !!this.config.nekoUrl; }
  private url(path: string) { return new URL(path, this.config.nekoUrl); }
  private async request(path: string, token?: string, method = 'GET', body?: unknown, timeout = 3000) {
    return fetch(this.url(path), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  }
  private async admin(path: string, method = 'POST', body?: unknown) {
    const response = await this.request(path, this.config.nekoApiToken, method, body);
    await response.body?.cancel();
    if (!response.ok) throw new Error('neko unavailable');
  }
  start() {
    if (!this.enabled) return;
    void this.health();
    this.timer = setInterval(() => { void this.health().then(ok => { if (ok) { this.changed(); void this.cleanup(); } }); }, 5000);
  }
  health(): Promise<boolean> {
    if (!this.enabled || this.stopped) return Promise.resolve(false);
    if (this.probe) return this.probe;
    this.probe = (async () => {
      try {
        const response = await this.request('/health', undefined, 'GET', undefined, 1000); await response.body?.cancel();
        if (!response.ok) throw 0;
        if (!this.ready) {
          await this.admin('/api/room/settings', 'POST', { locked_controls: true, implicit_hosting: false, control_protection: false });
          this.ready = true; this.changed();
        }
        return true;
      } catch { this.ready = false; return false; }
      finally { this.probe = undefined; }
    })();
    return this.probe;
  }
  private async login(id: string): Promise<NekoSession> {
    if (this.stopped || !this.sessions.byId(id)) throw new Error('Session expired');
    const cached = this.cache.get(id); if (cached) return cached;
    const pending = this.logins.get(id); if (pending) return pending;
    const promise = (async () => {
      const response = await this.request('/api/login', undefined, 'POST', { username: `tandem-${id.slice(0, 8)}`, password: this.config.nekoUserPassword });
      if (!response.ok) { await response.body?.cancel(); throw new Error('neko unavailable'); }
      const data = await response.json() as NekoSession;
      if (typeof data.id !== 'string' || !data.id || typeof data.token !== 'string' || !data.token) throw new Error('Invalid neko session');
      if (this.stopped || !this.sessions.byId(id)) { this.deletions.add(data.id); await this.cleanup(); throw new Error('Session expired'); }
      this.cache.set(id, { id: data.id, token: data.token });
      return this.cache.get(id)!;
    })();
    this.logins.set(id, promise);
    try { return await promise; } finally { this.logins.delete(id); }
  }
  private async viewer(id: string, path: string) {
    let session = await this.login(id), response = await this.request(path, session.token);
    if (response.status === 401) {
      await response.body?.cancel();
      if (this.cache.get(id) === session) { this.cache.delete(id); this.deletions.add(session.id); void this.cleanup(); }
      this.ready = false; if (!await this.health()) throw new Error('neko unavailable');
      session = await this.login(id); response = await this.request(path, session.token);
      this.changed();
    }
    return { response, session };
  }
  async proxy(id: string, path: string) {
    try {
      if (!await this.health()) throw 0;
      const { response } = await this.viewer(id, path), headers = new Headers({ 'cache-control': 'no-store' });
      const type = response.headers.get('content-type'); if (type) headers.set('content-type', type);
      return new Response(response.body, { status: response.status, headers });
    } catch { return Response.json({ error: 'neko_unavailable' }, { status: 502 }); }
  }
  async socket(id: string) {
    if (!await this.health()) throw new Error('neko unavailable');
    const { response, session } = await this.viewer(id, '/api/whoami');
    await response.body?.cancel(); if (!response.ok || !this.sessions.byId(id)) throw new Error('neko unavailable');
    const url = this.url('/api/ws'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(url, { headers: { authorization: `Bearer ${session.token}` } } as any);
    upstream.binaryType = 'arraybuffer';
    const frames: (string | ArrayBuffer)[] = []; this.pendingFrames.set(upstream, frames);
    let bytes = 0;
    upstream.onmessage = event => {
      bytes += typeof event.data === 'string' ? Buffer.byteLength(event.data) : event.data.byteLength;
      if (bytes > 2 * 1024 * 1024) upstream.close(); else frames.push(event.data);
    };
    return await new Promise<WebSocket>((resolve, reject) => {
      const timeout = setTimeout(() => { this.pendingFrames.delete(upstream); upstream.close(); reject(new Error('neko unavailable')); }, 3000);
      upstream.onopen = () => { clearTimeout(timeout); resolve(upstream); };
      upstream.onerror = upstream.onclose = () => { clearTimeout(timeout); this.pendingFrames.delete(upstream); reject(new Error('neko unavailable')); };
    });
  }
  attach(ws: Socket) {
    this.sockets.add(ws);
    const upstream = ws.data.upstream!;
    upstream.onmessage = event => {
      if (!this.sessions.byId(ws.data.sessionId)) { ws.close(4401, 'Session expired'); return; }
      if (ws.readyState !== 1) return;
      if (ws.getBufferedAmount() > 2 * 1024 * 1024) { ws.close(1013, 'WebRTC backpressure'); return; }
      if (typeof event.data === 'string') {
        try { if (JSON.parse(event.data).event === 'system/init') this.changed(); } catch {}
        ws.send(event.data);
      } else ws.send(new Uint8Array(event.data));
    };
    upstream.onerror = () => { this.ready = false; ws.close(1011, 'WebRTC unavailable'); };
    upstream.onclose = () => { this.ready = false; ws.close(1012, 'WebRTC disconnected'); };
    for (const data of this.pendingFrames.get(upstream) ?? []) upstream.onmessage!({ data } as MessageEvent);
    this.pendingFrames.delete(upstream);
    if (upstream.readyState !== WebSocket.OPEN) ws.close(1012, 'WebRTC disconnected');
    this.changed();
  }
  message(ws: Socket, data: string | Buffer) {
    if (!this.sessions.byId(ws.data.sessionId, true)) { ws.close(4401, 'Session expired'); return; }
    const upstream = ws.data.upstream!;
    if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 2 * 1024 * 1024) { ws.close(1013, 'WebRTC backpressure'); return; }
    upstream.send(data);
  }
  sweep() { for (const ws of this.sockets) if (!this.sessions.byId(ws.data.sessionId)) ws.close(4401, 'Session expired'); }
  detach(ws: Socket) { this.sockets.delete(ws); ws.data.upstream?.close(); }
  changed() {
    if (!this.enabled || this.stopped) return;
    this.controlQueue = this.controlQueue.then(async () => {
      if (this.stopped || !await this.health()) return;
      const holder = this.control.controller === 'human' ? this.control.holderSessionId : undefined;
      if (holder && this.sessions.byId(holder)) {
        const { response } = await this.viewer(holder, '/api/whoami'); await response.body?.cancel();
        if (!response.ok) throw 0;
        const current = this.cache.get(holder)!;
        if (!this.control.holds(holder) || !this.sessions.byId(holder)) return;
        await this.admin(`/api/room/control/give/${encodeURIComponent(current.id)}`);
      } else await this.admin('/api/room/control/reset');
    }).catch(() => { this.ready = false; log('neko.control_unavailable'); });
  }
  screen(id: string, w: unknown, h: unknown) {
    if (!this.enabled) return;
    if (!screenSize(w, h)) throw new Error('Invalid screen size');
    clearTimeout(this.screenTimer);
    this.screenTimer = setTimeout(() => {
      this.screenQueue = this.screenQueue.then(async () => {
        if (this.stopped || !this.sessions.byId(id) || !await this.health()) return;
        await this.admin('/api/room/screen', 'POST', { width: w, height: h, rate: 25 });
      }).catch(() => { this.ready = false; log('neko.screen_unavailable'); });
    }, 500);
  }
  revoke(id: string) {
    const session = this.cache.get(id); this.cache.delete(id);
    for (const ws of this.sockets) if (ws.data.sessionId === id) ws.close(4401, 'Session expired');
    if (session) { this.deletions.add(session.id); void this.cleanup(); }
  }
  private async cleanup() {
    for (const id of this.deletions) {
      try {
        const response = await this.request(`/api/sessions/${encodeURIComponent(id)}`, this.config.nekoApiToken, 'DELETE');
        await response.body?.cancel(); if (response.ok || response.status === 404) this.deletions.delete(id);
      } catch {}
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.screenTimer);
    for (const ws of this.sockets) { ws.data.upstream?.close(); ws.terminate(); }
    await Promise.allSettled([...this.logins.values(), this.controlQueue, this.screenQueue, this.probe]);
    for (const session of this.cache.values()) this.deletions.add(session.id);
    this.cache.clear(); await this.cleanup();
  }
}
