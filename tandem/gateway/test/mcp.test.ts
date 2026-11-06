import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Audit } from '../src/audit';
import { Control } from '../src/control';
import type { Cdp } from '../src/cdp';
import { McpProxy, PAUSED_TEXT, parseRpcText } from '../src/mcp';

const cleanup: (() => unknown)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function setup(holdMs = 80, cdp?: Cdp) {
  const seen: any[] = [];
  let deletions = 0;
  let tools: any[] = [{ name: 'read', annotations: { readOnlyHint: true } }, { name: 'write', annotations: { readOnlyHint: false } }, { name: 'no-hint' }];
  const upstream = Bun.serve({ port: 0, async fetch(req) {
    if (req.method === 'DELETE') { deletions++; return new Response(null, { status: 204 }); }
    if (req.method === 'GET' && req.headers.get('mcp-session-id') === 'stale') return new Response('session not found', { status: 404 });
    if (req.method === 'GET') return new Response('event: message\ndata: {"test":true}\n\n', { headers: { 'content-type': 'text/event-stream', 'last-event-id': req.headers.get('last-event-id') ?? '' } });
    const rpc = await req.json() as any; seen.push(rpc);
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result: any = {};
    if (rpc.method === 'initialize') result = { protocolVersion: '2024-11-05' };
    if (rpc.method === 'tools/list') result = { tools };
    if (rpc.method === 'tools/call') result = { content: [{ type: 'text', text: rpc.params?.name === 'url-result' ? 'Found https://example.org/ (open tab)' : 'ok' }] };
    const text = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`;
    const headers = { 'content-type': 'text/event-stream', 'mcp-session-id': req.headers.get('mcp-session-id') ?? 'cache-session', 'mcp-protocol-version': req.headers.get('mcp-protocol-version') ?? '2024-11-05' };
    if (rpc.params?.name === 'slow') {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': first byte\n\n'));
        setTimeout(() => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }, 100);
      } }), { headers });
    }
    return new Response(text, { headers });
  } }); cleanup.push(() => upstream.stop(true));
  const dir = mkdtempSync(join(tmpdir(), 'tandem-mcp-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const audit = new Audit(dir); cleanup.push(() => audit.close());
  const control = new Control(dir, audit, 1000); cleanup.push(() => control.close());
  const proxy = new McpProxy({ mcpUrl: `http://127.0.0.1:${upstream.port}/mcp`, holdMs }, control, audit, cdp); cleanup.push(() => proxy.close());
  await proxy.refresh(); const startup = seen.map(r => r.method); seen.length = 0;
  const request = (rpc: unknown, method = 'POST') => new Request('http://gateway/mcp', { method, headers: { 'content-type': 'application/json', 'mcp-session-id': 'agent-session', 'mcp-protocol-version': '2025-03-26', 'last-event-id': 'event-1' }, ...(method === 'POST' ? { body: JSON.stringify(rpc) } : {}) });
  return { seen, control, proxy, request, audit, startup, deletions, setTools: (next: any[]) => { tools = next; } };
}
describe('MCP proxy', () => {
  test('startup annotation session is initialized, closed and read-only passes during human control', async () => {
    const { proxy, request, control, seen, startup, deletions } = await setup(); expect(startup).toEqual(['initialize', 'notifications/initialized', 'tools/list']); expect(deletions).toBe(1); expect(proxy.healthy).toBe(true); control.take('human');
    const response = await proxy.handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read' } }));
    expect(response.headers.get('content-type')).toContain('text/event-stream'); expect(await response.text()).toContain('"id":1'); expect(seen).toHaveLength(1);
    expect(control.activeAgentCalls).toBe(0);
  });
  test('mutating call is held and released with original id and headers', async () => {
    const { proxy, request, control, seen } = await setup(1000); control.take('human');
    const waiting = proxy.handle(request({ jsonrpc: '2.0', id: 'original-id', method: 'tools/call', params: { name: 'write' } }));
    await Bun.sleep(20); expect(seen).toHaveLength(0); expect(control.pendingAgentCalls).toBe(1); control.release('human');
    const response = await waiting; expect(response.headers.get('mcp-session-id')).toBe('agent-session'); expect(response.headers.get('mcp-protocol-version')).toBe('2025-03-26');
    expect(await response.text()).toContain('original-id'); expect(control.pendingAgentCalls).toBe(0);
  });
  test('timeout returns exact isError text with correct JSON-RPC id', async () => {
    const { proxy, request, control, seen } = await setup(15); control.take('human');
    const response = await proxy.handle(request({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'write', arguments: { secret: 'do-not-log' } } }));
    expect(response.headers.get('content-type')).toContain('application/json'); expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 77, result: { content: [{ type: 'text', text: PAUSED_TEXT }], isError: true } });
    expect(seen).toHaveLength(0);
  });
  test('unknown tools and missing annotations are mutating', async () => {
    const { proxy, request, control, seen } = await setup(10); control.take('human');
    for (const name of ['unknown', 'no-hint']) {
      const response = await proxy.handle(request({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name } }));
      expect((await response.json() as any).result.isError).toBe(true);
    }
    expect(seen).toHaveLength(0);
  });
  test('methods other than tools/call always pass', async () => {
    const { proxy, request, control } = await setup(); control.take('human');
    for (const method of ['initialize', 'tools/list', 'ping']) {
      const response = await proxy.handle(request({ jsonrpc: '2.0', id: method, method })); expect(response.status).toBe(200); await response.text();
    }
    expect((await proxy.handle(request({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status).toBe(202);
  });
  test('batch forwards read-only members immediately while holding mutation', async () => {
    const { proxy, request, control, seen } = await setup(1000); control.take('human');
    const pending = proxy.handle(request([{ jsonrpc: '2.0', id: 'read-id', method: 'tools/call', params: { name: 'read' } }, { jsonrpc: '2.0', id: 'write-id', method: 'tools/call', params: { name: 'write' } }]));
    await Bun.sleep(20); expect(seen.map(v => v.params.name)).toEqual(['read']); control.release('human');
    const response = await pending; expect((await response.json() as any[]).map(v => v.id)).toEqual(['read-id', 'write-id']);
  });
  test('batch timeout preserves ids and only denies mutation', async () => {
    const { proxy, request, control } = await setup(15); control.take('human');
    const response = await proxy.handle(request([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write' } }]));
    const values = await response.json() as any[]; expect(values[0].id).toBe(1); expect(values[1].id).toBe(2); expect(values[1].result.isError).toBe(true);
  });
  test('SSE bytes arrive before completion, response remains byte-for-byte', async () => {
    const { proxy, request, control } = await setup();
    const response = await proxy.handle(request({ jsonrpc: '2.0', id: 'slow-id', method: 'tools/call', params: { name: 'slow' } }));
    const reader = response.body!.getReader(); let complete = false;
    const started = Date.now(); const first = await reader.read(); expect(Date.now() - started).toBeLessThan(80);
    expect(new TextDecoder().decode(first.value)).toBe(': first byte\n\n'); expect(control.activeAgentCalls).toBe(1);
    let text = ''; while (!complete) { const chunk = await reader.read(); complete = chunk.done; text += new TextDecoder().decode(chunk.value); }
    expect(text).toBe('event: message\ndata: {"jsonrpc":"2.0","id":"slow-id","result":{"content":[{"type":"text","text":"ok"}]}}\n\n'); expect(control.activeAgentCalls).toBe(0);
  });
  test('GET/DELETE and last-event-id pass through', async () => {
    const { proxy, request } = await setup();
    const response = await proxy.handle(request(undefined, 'GET')); expect(response.headers.get('last-event-id')).toBe('event-1'); expect(await response.text()).toContain('"test":true');
    expect((await proxy.handle(request(undefined, 'DELETE'))).status).toBe(204);
  });
  test('a client error from a stale session leaves MCP healthy', async () => {
    const { proxy } = await setup();
    const response = await proxy.handle(new Request('http://gateway/mcp', { method: 'GET', headers: { 'mcp-session-id': 'stale' } }));
    expect(response.status).toBe(404); await response.body?.cancel(); expect(proxy.healthy).toBe(true);
  });
  test('passing tools/list responses refresh annotations during human control', async () => {
    const { proxy, request, control, setTools } = await setup(10); control.take('human');
    let response = await proxy.handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dynamic' } })); expect((await response.json() as any).result.isError).toBe(true);
    setTools([{ name: 'dynamic', annotations: { readOnlyHint: true } }]); response = await proxy.handle(request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })); await response.text();
    response = await proxy.handle(request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dynamic' } })); expect(await response.text()).toContain('"text":"ok"');
  });
  test('tool response URLs matching open tabs emit activity only while agent controls', async () => {
    const activity: unknown[] = [];
    const cdp = { tabs: new Map([['matching', { targetId: 'matching', url: 'https://example.org/' }], ['other', { targetId: 'other', url: 'https://elsewhere.example/' }]]), activity: (...args: unknown[]) => activity.push(args) } as unknown as Cdp;
    const { proxy, request, control } = await setup(80, cdp);
    expect(control.controller).toBe('agent');
    const response = await proxy.handle(request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'url-result' } })); expect(await response.text()).toContain('https://example.org/');
    expect(activity).toEqual([['matching', 'url-result']]);
  });
  test('SSE multi-line data parses and malformed data is ignored', () => {
    expect(parseRpcText('event: message\r\ndata: {"id":1,\r\ndata: "result":{}}\r\n\r\n', 'text/event-stream')).toEqual([{ id: 1, result: {} }]);
    expect(parseRpcText('data: junk\n\n', 'text/event-stream')).toEqual([]);
  });
});
