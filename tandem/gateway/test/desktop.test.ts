import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config';
import { createGateway } from '../src/server';

const origin = 'http://127.0.0.1:8790', received: Buffer[] = [], upstreams: ServerWebSocket<unknown>[] = [];
let gateway: ReturnType<typeof createGateway>, engine: ReturnType<typeof Bun.serve>, dir: string;
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await Bun.sleep(5); } throw new Error('Timed out'); }
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tandem-desktop-')); writeFileSync(join(dir, 'brand.json'), '{}');
  engine = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) { if (server.upgrade(req, { data: undefined })) return; return new Response('', { status: 400 }); }, websocket: {
    open(ws) { upstreams.push(ws); ws.send(Buffer.from('RFB 003.008\n')); }, message(_ws, data) { received.push(Buffer.from(data)); },
  } });
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); const port = listener.port; listener.stop();
  gateway = createGateway(await loadConfig({ TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: origin, TANDEM_PASSWORD: crypto.randomUUID(), TANDEM_AGENT_TOKEN: crypto.randomUUID() + crypto.randomUUID(),
    TANDEM_DATA_DIR: dir, TANDEM_PUBLIC_DIR: new URL('./fixtures/public', import.meta.url).pathname, TANDEM_BRAND_FILE: join(dir, 'brand.json'), TANDEM_LISTEN: `127.0.0.1:${port}`,
    TANDEM_CDP_URL: 'http://127.0.0.1:1', TANDEM_NEO_MCP_URL: 'http://127.0.0.1:1/mcp', TANDEM_NOVNC_URL: `http://127.0.0.1:${engine.port}` }));
});
afterAll(async () => { await gateway.close(); void engine.stop(true); rmSync(dir, { recursive: true, force: true }); });
async function desktop() {
  const { token, session } = gateway.sessions.create(), chunks: Buffer[] = [], index = upstreams.length;
  const ws = new WebSocket(`ws://127.0.0.1:${gateway.server.port}/desktop/websockify`, { headers: { cookie: `tandem_session=${token}`, origin }, protocols: ['binary'] } as any); ws.binaryType = 'arraybuffer';
  ws.onmessage = e => chunks.push(Buffer.from(e.data));
  const closed = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); });
  await until(() => chunks.length > 0);
  return { ws, session, chunks, closed, upstream: upstreams[index]! };
}
test('desktop watches without control, filters input across control changes, and remains connected', async () => {
  const { ws, session, chunks, upstream } = await desktop();
  try {
    expect(Buffer.concat(chunks).toString()).toBe('RFB 003.008\n');
    const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]), key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 97]), request = Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]);
    let mark = received.length; ws.send(Buffer.concat([handshake, key, request])); await until(() => received.length >= mark + 4);
    expect(Buffer.concat(received.slice(mark))).toEqual(Buffer.concat([handshake, request]));
    gateway.control.take(session.id); mark = received.length; ws.send(key); await until(() => received.length > mark); expect(received[mark]).toEqual(key);
    const other = gateway.sessions.create(); gateway.control.take(other.session.id); mark = received.length;
    ws.send(Buffer.concat([key, request])); await until(() => received.length > mark); expect(Buffer.concat(received.slice(mark))).toEqual(request);
    gateway.control.release(other.session.id); mark = received.length; ws.send(Buffer.concat([key, request])); await until(() => received.length > mark); expect(Buffer.concat(received.slice(mark))).toEqual(request);
    const response = Buffer.from([0, 0, 1, 2, 3, 4]); upstream.send(response); await until(() => chunks.length > 1); expect(chunks.at(-1)).toEqual(response);
    expect(ws.readyState).toBe(WebSocket.OPEN); expect(gateway.audit.tail(20).some(e => e.event === 'desktop.open' && e.sessionId === session.id)).toBe(true);
  } finally { ws.close(); }
});
test('desktop unknown type and oversize clipboard close 4403', async () => {
  for (const bad of [Buffer.from([99]), Buffer.from([6, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff])]) {
    const { ws, closed } = await desktop(); ws.send(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), bad])); expect(await closed).toBe(4403);
  }
});
test('desktop session revoke closes 4401 even without control', async () => {
  const { ws, session, closed } = await desktop(); gateway.sessions.revoke(session.id); expect(await closed).toBe(4401); expect(ws.readyState).toBe(WebSocket.CLOSED);
});
