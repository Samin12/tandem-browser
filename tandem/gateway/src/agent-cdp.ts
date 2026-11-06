import type { ServerWebSocket } from 'bun';
import type { Config } from './config';
import type { Control } from './control';
import type { Audit } from './audit';
import type { Cdp } from './cdp';
import { constantEqual } from './security';

export const CDP_LIMIT = 8, CDP_BYTES = 32 * 1024 * 1024;
export const CDP_PAUSED = 'Tandem: a person has control of the browser; try again later';
interface Route { token?: string; path: string; socket: boolean }
export function cdpRoute(path: string): Route | undefined {
  if (!path.startsWith('/cdp/')) return;
  const parts = path.slice(5).split('/');
  let token: string | undefined;
  if (!['json', 'devtools'].includes(parts[0]!)) {
    try { token = decodeURIComponent(parts.shift()!); } catch { return; }
  }
  // Playwright's HTTP discovery appends a slash to /json/version.
  const raw = '/' + parts.join('/');
  const target = /^\/json(?:\/(version|list))?\/$/.test(raw) ? raw.slice(0, -1) : raw;
  return { token, path: target, socket: /^\/devtools\/(browser|page)\/[A-Za-z0-9_-]+$/.test(target) };
}
export function agentAuthorized(req: Request, token: string, pathToken?: string) {
  const header = req.headers.get('authorization') ?? '';
  return pathToken !== undefined ? constantEqual(pathToken, token) : header.startsWith('Bearer ') && constantEqual(header.slice(7), token);
}
export function rewriteCdp(value: any, origin: string, token?: string): any {
  const base = new URL(origin), prefix = `/cdp${token === undefined ? '' : '/' + encodeURIComponent(token)}`;
  const debuggerUrl = (raw: string, frontend = false) => {
    const url = new URL(raw.includes('://') ? raw : 'ws://' + raw);
    if (!/^\/devtools\/(browser|page)\/[^/]+$/.test(url.pathname)) return '';
    return `${frontend ? '' : base.protocol === 'https:' ? 'wss://' : 'ws://'}${base.host}${prefix}${url.pathname}`;
  };
  if (Array.isArray(value)) return value.map(v => rewriteCdp(v, origin, token));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'webSocketDebuggerUrl' && typeof item === 'string') return [key, debuggerUrl(item)];
    if (key === 'devtoolsFrontendUrl' && typeof item === 'string') {
      const url = new URL(item, origin);
      const entries = ['ws', 'wss'].filter(param => url.searchParams.has(param)).map(param => [param, url.searchParams.get(param)!]);
      for (const [param, raw] of entries) {
        url.searchParams.delete(param!);
        url.searchParams.set(base.protocol === 'https:' ? 'wss' : 'ws', debuggerUrl(raw!, true));
      }
      return [key, url.href];
    }
    return [key, rewriteCdp(item, origin, token)];
  }));
}
const READ_ONLY = new Set([
  'Target.getTargets', 'Target.getTargetInfo', 'Target.getBrowserContexts', 'Target.setDiscoverTargets', 'Target.setAutoAttach', 'Target.attachToTarget', 'Target.detachFromTarget',
  'Browser.getVersion', 'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getFrameTree', 'Page.getNavigationHistory',
  'DOM.getDocument', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.querySelector', 'DOM.querySelectorAll', 'DOM.getOuterHTML', 'DOM.resolveNode',
  'DOMSnapshot.captureSnapshot', 'Accessibility.getFullAXTree', 'Accessibility.getPartialAXTree', 'Accessibility.queryAXTree',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
]);
export const cdpReadOnly = (method: string) => READ_ONLY.has(method) || /^[A-Za-z]+\.(enable|disable)$/.test(method);
interface Command { id: number; sessionId?: string; method: string; params?: any }
interface Held { raw: string; command: Command; at: number; timer: ReturnType<typeof setTimeout> }
interface Peer { send(data: string): unknown; close(code?: number, reason?: string): void }

// Each socket owns its queue and CDP IDs; responses/events never wait behind control.
export class AgentCdpConnection {
  private held: Held[] = [];
  private bytes = 0;
  private draining = false;
  private stopped = false;
  private abort = new AbortController();
  private pending = new Map<string, Command>();
  private targets = new Map<string, string>();
  private methods = new Map<string, number>();
  private began = Date.now();
  private messages = 0;
  private heldCount = 0;
  private rejected = 0;
  constructor(private client: Peer, private upstream: Peer, private control: Control, private audit: Audit,
    private holdMs: number, private cdp?: Cdp, private pageTarget?: string, private token?: string) {
    audit.write('agent', 'cdp.connect');
  }
  private key(command: { id: number; sessionId?: string }) { return JSON.stringify([command.sessionId, command.id]); }
  message(raw: string) {
    if (this.stopped) return;
    let command: Command;
    try { command = JSON.parse(raw); } catch { this.client.close(4403, 'Invalid CDP message'); return; }
    if (!command || !Number.isSafeInteger(command.id) || typeof command.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(command.method)
      || command.method.length > 100 || (command.sessionId !== undefined && typeof command.sessionId !== 'string')) { this.client.close(4403, 'Invalid CDP message'); return; }
    this.messages++;
    const safeMethod = this.token && command.method.includes(this.token) ? 'redacted' : command.method;
    const method = this.methods.size < 128 || this.methods.has(safeMethod) ? safeMethod : 'other';
    this.methods.set(method, (this.methods.get(method) ?? 0) + 1);
    if (cdpReadOnly(command.method)) { this.forward(raw, command); return; }
    if (this.control.controller === 'agent' && !this.held.length) { this.forward(raw, command); return; }
    if (this.held.length >= 1024 || this.bytes + Buffer.byteLength(raw) > CDP_BYTES) { this.rejected++; this.error(command, 'Tandem: CDP queue full'); return; }
    const item: Held = { raw, command, at: Date.now(), timer: setTimeout(() => {
      const index = this.held.indexOf(item); if (index < 0) return;
      this.held.splice(index, 1); this.bytes -= Buffer.byteLength(raw); this.rejected++; this.error(command, CDP_PAUSED);
    }, this.holdMs) };
    this.held.push(item); this.bytes += Buffer.byteLength(raw); this.heldCount++; void this.drain();
  }
  private error(command: Command, message: string) { this.client.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, error: { code: -32000, message } })); }
  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.held.length) {
        if (this.control.controller === 'human') { await this.control.waitForAgent(this.holdMs, this.abort.signal); continue; }
        const item = this.held.shift()!; clearTimeout(item.timer); this.bytes -= Buffer.byteLength(item.raw);
        if (Date.now() - item.at >= this.holdMs) { this.rejected++; this.error(item.command, CDP_PAUSED); }
        else this.forward(item.raw, item.command);
      }
    } finally { this.draining = false; }
  }
  private forward(raw: string, command: Command) {
    if (this.pending.size >= 4096 || this.pending.has(this.key(command))) { this.rejected++; this.error(command, 'Tandem: too many pending CDP commands or duplicate ID'); return; }
    this.pending.set(this.key(command), command); this.control.started(command.method);
    const target = command.params?.targetId ?? (command.sessionId ? this.targets.get(command.sessionId) : this.pageTarget);
    if (typeof target === 'string') this.cdp?.activity(target, command.method);
    this.upstream.send(raw);
  }
  response(raw: string) {
    if (this.stopped) return;
    // Observe metadata only. Forward the original bytes, including multi-MB screenshots.
    try {
      const value = JSON.parse(raw);
      if (value.id !== undefined) {
        const key = this.key(value), command = this.pending.get(key);
        if (command) {
          this.pending.delete(key); this.control.finished();
          if (command.method === 'Target.attachToTarget' && value.result?.sessionId) this.targets.set(value.result.sessionId, command.params?.targetId);
          if (command.method === 'Target.detachFromTarget') this.targets.delete(command.params?.sessionId);
          if (command.method === 'Target.createTarget' && value.result?.targetId) this.cdp?.activity(value.result.targetId, command.method);
        }
      } else if (value.method === 'Target.attachedToTarget') this.targets.set(value.params.sessionId, value.params.targetInfo.targetId);
      else if (value.method === 'Target.detachedFromTarget') this.targets.delete(value.params.sessionId);
    } catch {}
    this.client.send(raw);
  }
  close() {
    if (this.stopped) return; this.stopped = true; this.abort.abort();
    for (const item of this.held) clearTimeout(item.timer);
    this.held = []; this.bytes = 0;
    for (const command of this.pending.values()) this.control.finished();
    this.pending.clear(); this.upstream.close();
    this.audit.write('agent', 'cdp.disconnect', { durationMs: Date.now() - this.began, messages: this.messages, held: this.heldCount, rejected: this.rejected,
      topMethods: [...this.methods].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([method, count]) => ({ method, count })) });
  }
}
export interface AgentCdpSocketData { upstream?: WebSocket; agentCdp?: AgentCdpConnection }
export class AgentCdpProxy {
  private sockets = new Set<ServerWebSocket<AgentCdpSocketData>>();
  private reservations = 0;
  constructor(private config: Config, private control: Control, private audit: Audit, private cdp: Cdp) {}
  reserve() { if (this.sockets.size + this.reservations >= CDP_LIMIT) return false; this.reservations++; return true; }
  release() { this.reservations--; }
  async discovery(path: string, token?: string, origin = this.config.origins[0]!) {
    if (!['/json', '/json/list', '/json/version'].includes(path)) return Response.json({ error: 'not_found' }, { status: 404 });
    try {
      const url = new URL(path, this.config.cdpUrl);
      const response = await fetch(url, { headers: { host: url.host }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw 0;
      return Response.json(rewriteCdp(await response.json(), origin, token));
    } catch { return Response.json({ error: 'upstream_unavailable' }, { status: 502 }); }
  }
  async socket(path: string) {
    const url = new URL(path, this.config.cdpUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(url, { headers: { host: url.host } } as any);
    return await new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => { upstream.close(); reject(new Error('CDP unavailable')); }, 5000);
      upstream.onopen = () => { clearTimeout(timer); resolve(upstream); };
      upstream.onerror = upstream.onclose = () => { clearTimeout(timer); reject(new Error('CDP unavailable')); };
    });
  }
  attach(ws: ServerWebSocket<AgentCdpSocketData>, path: string) {
    this.release(); this.sockets.add(ws);
    const upstream = ws.data.upstream!;
    const client: Peer = { send: data => {
      if (ws.getBufferedAmount() > CDP_BYTES) { ws.close(1013, 'CDP backpressure'); return; }
      ws.send(data);
    }, close: (code, reason) => ws.close(code, reason) };
    const connection = ws.data.agentCdp = new AgentCdpConnection(client, { send: data => {
      if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount > CDP_BYTES) { ws.close(1013, 'CDP backpressure'); return; }
      upstream.send(data);
    }, close: () => upstream.close() }, this.control, this.audit, this.config.holdMs, this.cdp, path.startsWith('/devtools/page/') ? path.split('/').pop() : undefined, this.config.agentToken);
    upstream.onmessage = event => connection.response(String(event.data));
    upstream.onerror = () => ws.close(1011, 'CDP unavailable'); upstream.onclose = () => ws.close(1012, 'CDP disconnected');
    if (upstream.readyState !== WebSocket.OPEN) ws.close(1012, 'CDP disconnected');
  }
  detach(ws: ServerWebSocket<AgentCdpSocketData>) { this.sockets.delete(ws); ws.data.agentCdp?.close(); }
  close() { for (const ws of this.sockets) { ws.data.agentCdp?.close(); ws.terminate(); } this.sockets.clear(); }
}
