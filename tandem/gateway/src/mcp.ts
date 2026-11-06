import type { Config } from './config';
import type { Control } from './control';
import type { Audit } from './audit';
import type { Cdp } from './cdp';

export const PAUSED_TEXT = 'Tandem: a person has manual control of the browser, so browser actions are paused. Wait a minute and try again; do not switch to another browser.';
export const pausedResult = (id: unknown) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: PAUSED_TEXT }], isError: true } });
const headerNames = ['mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
interface Rpc { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any }
export function parseRpcText(text: string, type: string): any[] {
  if (type.includes('text/event-stream')) {
    return text.replace(/\r\n/g, '\n').split('\n\n').flatMap(event => {
      const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      try { return data ? [JSON.parse(data)] : []; } catch { return []; }
    });
  }
  try { const value = JSON.parse(text); return Array.isArray(value) ? value : [value]; } catch { return []; }
}
export class McpProxy {
  healthy = false;
  private readOnly = new Map<string, boolean>();
  private timer?: ReturnType<typeof setInterval>;
  private refreshInFlight?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private shutdown = new AbortController();
  constructor(private config: Pick<Config, 'mcpUrl' | 'holdMs'>, private control: Control, private audit: Audit, private cdp?: Cdp) {}
  start() { void this.refresh(); this.timer = setInterval(() => void this.refresh(), 10 * 60000); }
  private headers(req?: Request) {
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
    for (const name of headerNames) { const value = req?.headers.get(name); if (value) headers.set(name, value); }
    return headers;
  }
  private learn(value: any) {
    if (Array.isArray(value?.result?.tools)) {
      this.readOnly.clear();
      for (const tool of value.result.tools) if (typeof tool?.name === 'string') this.readOnly.set(tool.name, tool.annotations?.readOnlyHint === true);
    }
  }
  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.fetchAnnotations().finally(() => { this.refreshInFlight = undefined; });
    return this.refreshInFlight;
  }
  private async fetchAnnotations() {
    const headers = this.headers();
    const send = async (body: unknown) => fetch(this.config.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(10000)]) });
    try {
      const init = await send({ jsonrpc: '2.0', id: 'tandem-init', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tandem-gateway-cache', version: '0.1.0' } } });
      const session = init.headers.get('mcp-session-id');
      const initValues = parseRpcText(await init.text(), init.headers.get('content-type') ?? '');
      if (!init.ok || !initValues.some(v => v.result?.protocolVersion)) throw new Error('Initialization failed');
      if (session) headers.set('mcp-session-id', session);
      const protocolVersion = initValues.find(v => v.result?.protocolVersion)?.result.protocolVersion;
      if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion);
      const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await notification.body?.cancel();
      const response = await send({ jsonrpc: '2.0', id: 'tandem-tools', method: 'tools/list' });
      const values = parseRpcText(await response.text(), response.headers.get('content-type') ?? '');
      if (!response.ok || !values.some(v => Array.isArray(v.result?.tools))) throw new Error('Tool list unavailable');
      for (const value of values) this.learn(value);
      this.healthy = true;
    } catch { this.healthy = false; }
    finally {
      if (!this.healthy && !this.stopped && !this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.refresh(); }, 5000);
      if (headers.has('mcp-session-id')) {
        try { const response = await fetch(this.config.mcpUrl, { method: 'DELETE', headers, signal: AbortSignal.timeout(5000) }); await response.body?.cancel(); } catch {}
      }
    }
  }
  private observe(value: any, request?: Rpc) {
    if (!request || value?.id !== request.id) return;
    if (request.method === 'tools/list') this.learn(value);
    if (request.method !== 'tools/call' || !value?.result || !this.cdp || this.control.controller !== 'agent') return;
    const content = value.result.content;
    if (!Array.isArray(content)) return;
    const urls = new Set<string>();
    for (const item of content) if (item?.type === 'text' && typeof item.text === 'string') {
      for (const match of item.text.matchAll(/https?:\/\/[^\s<>"'`\\)\]}]+/g)) {
        try { urls.add(new URL(match[0]).href); } catch {}
      }
    }
    for (const tab of this.cdp.tabs.values()) if (urls.has(tab.url)) this.cdp.activity(tab.targetId, request.params?.name);
  }
  async handle(req: Request): Promise<Response> {
    req = new Request(req, { signal: AbortSignal.any([req.signal, this.shutdown.signal]) });
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    if (req.method !== 'POST') return this.forward(req);
    let body: unknown;
    try { body = await req.json(); } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }); }
    const valid = (value: any): value is Rpc => value && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0' && typeof value.method === 'string'
      && (value.id === undefined || value.id === null || typeof value.id === 'string' || typeof value.id === 'number');
    if (Array.isArray(body)) {
      if (!body.length || body.length > 100 || !body.every(valid)) return Response.json({ error: 'invalid_batch' }, { status: 400 });
      const batchHeaders = new Headers();
      const responses = await Promise.all(body.map(async rpc => {
        const response = await this.call(req, rpc);
        for (const name of headerNames) { const value = response.headers.get(name); if (value && !batchHeaders.has(name)) batchHeaders.set(name, value); }
        const values = parseRpcText(await response.text(), response.headers.get('content-type') ?? '');
        if (rpc.id === undefined) return undefined;
        return values.find(v => v.id === rpc.id) ?? { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Upstream response unavailable' } };
      }));
      const values = responses.filter(v => v !== undefined);
      return values.length ? Response.json(values, { headers: batchHeaders }) : new Response(null, { status: 202, headers: batchHeaders });
    }
    if (!valid(body)) return Response.json({ error: 'invalid_rpc' }, { status: 400 });
    return this.call(req, body);
  }
  private async call(req: Request, rpc: Rpc): Promise<Response> {
    if (rpc.method !== 'tools/call') return this.forward(req, rpc);
    const name = typeof rpc.params?.name === 'string' ? rpc.params.name : 'unknown';
    const mutating = this.readOnly.get(name) !== true;
    const began = Date.now();
    while (mutating && this.control.controller === 'human') {
      const result = await this.control.waitForAgent(Math.max(1, this.config.holdMs - (Date.now() - began)), req.signal);
      if (result !== 'ready') {
        this.audit.write('agent', 'agent.denied', { name, heldMs: Date.now() - began, outcome: result === 'timeout' ? 'timeout' : 'cancelled' });
        return rpc.id !== undefined ? Response.json(pausedResult(rpc.id)) : new Response(null, { status: 202 });
      }
    }
    const heldMs = Date.now() - began;
    this.control.started(name);
    let complete = false;
    const finish = (outcome: string) => {
      if (complete) return; complete = true;
      this.control.finished(); this.audit.write('agent', 'agent.tool', { name, heldMs, outcome });
    };
    return this.forward(req, rpc, finish);
  }
  private async forward(req: Request, rpc?: Rpc, finish?: (outcome: string) => void): Promise<Response> {
    try {
      const upstream = await fetch(this.config.mcpUrl, {
        method: req.method, headers: this.headers(req), ...(rpc ? { body: JSON.stringify(rpc) } : {}), signal: req.signal,
      });
      // A client's stale session or bad request (4xx) says nothing about Neo itself.
      this.healthy = upstream.status < 500;
      const headers = new Headers();
      for (const name of [...headerNames, 'content-type', 'cache-control']) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
      if (!upstream.body) { finish?.(upstream.ok ? 'ok' : 'error'); return new Response(null, { status: upstream.status, headers }); }
      const reader = upstream.body.getReader(), decoder = new TextDecoder();
      const sse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
      let buffer = '', toolError = false;
      const observe = (text: string) => {
        for (const value of parseRpcText(text, sse ? 'text/event-stream' : 'application/json')) {
          if (rpc && value?.id === rpc.id && (value.error || value.result?.isError)) toolError = true;
          this.observe(value, rpc);
        }
      };
      const stream = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              buffer += decoder.decode(); if (buffer) observe(buffer);
              finish?.(upstream.ok && !toolError ? 'ok' : 'error'); controller.close(); return;
            }
            // Observe a bounded copy without delaying, rewriting or buffering the stream itself.
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
            if (sse) {
              let end: number;
              while ((end = buffer.indexOf('\n\n')) >= 0) { observe(buffer.slice(0, end + 2)); buffer = buffer.slice(end + 2); }
            }
            if (buffer.length > 16 * 1024 * 1024) buffer = '';
            controller.enqueue(value);
          } catch { finish?.('error'); controller.error(new Error('Upstream stream disconnected')); }
        },
        cancel: async () => { finish?.('cancelled'); await reader.cancel(); },
      });
      return new Response(stream, { status: upstream.status, headers });
    } catch {
      this.healthy = false; finish?.('error');
      return Response.json({ error: 'upstream_unavailable' }, { status: 502 });
    }
  }
  close() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.retry); this.shutdown.abort(); }
}
