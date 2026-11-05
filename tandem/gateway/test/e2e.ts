import { PAUSED_TEXT, parseRpcText } from '../src/mcp';
import { totp } from '../src/security';
import { Cdp } from '../src/cdp';

const base = process.env.TANDEM_URL?.replace(/\/$/, '');
const origin = process.env.TANDEM_ORIGIN;
const password = process.env.TANDEM_TEST_PASSWORD;
const agent = process.env.TANDEM_AGENT_TOKEN;
if (!base || !origin || !password || !agent) {
  console.error('Required: TANDEM_URL, TANDEM_ORIGIN, TANDEM_TEST_PASSWORD, TANDEM_AGENT_TOKEN'); process.exit(1);
}
let passed = 0, failed = 0, cookie = '', sessionId = '', mcpSession = '', protocol = '2024-11-05';
let ws: WebSocket | undefined;
const messages: any[] = [], frames: Buffer[] = [], createdTabs = new Set<string>();
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'failed'}`); throw error; }
};
async function until<T>(fn: () => T | undefined | false | null, label: string, timeout = 20000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) { const result = fn(); if (result) return result; await Bun.sleep(20); }
  throw new Error(`Timed out: ${label}`);
}
const viewerFetch = (path: string, options: RequestInit = {}) => fetch(base + path, { ...options, headers: { cookie, origin: origin!, 'x-tandem': '1', ...options.headers }, signal: AbortSignal.timeout(30000) });
const send = (value: unknown) => ws!.send(JSON.stringify(value));
async function controlled(controller: string) {
  const mark = messages.length; send({ t: controller === 'human' ? 'control.take' : 'control.release' });
  await until(() => messages.slice(mark).find(m => m.t === 'control' && m.controller === controller && (controller !== 'human' || m.yours)), `control ${controller}`);
}
async function rpc(method: string, params?: unknown, id: string | number = crypto.randomUUID()) {
  const headers: Record<string, string> = { authorization: `Bearer ${agent}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': protocol };
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }), signal: AbortSignal.timeout(60000) });
  if (response.headers.has('mcp-session-id')) mcpSession = response.headers.get('mcp-session-id')!;
  assert(response.ok, `MCP HTTP status ${response.status}`);
  const values = parseRpcText(await response.text(), response.headers.get('content-type') ?? '');
  const value = values.find(v => v.id === id); assert(value, `No MCP response for ${method}`); assert(!value.error, `MCP JSON-RPC error for ${method}`);
  return value;
}
async function syncBrowser() {
  const mark = messages.length, reqId = crypto.randomUUID(); send({ t: 'clipboard.copy', targetId: [...createdTabs][0], reqId });
  await until(() => messages.slice(mark).find(m => m.t === 'clipboard' && m.reqId === reqId), 'browser command completion');
  assert(!messages.slice(mark).some(m => m.t === 'error'), 'Viewer command returned an error');
}
try {
  await check('stack health (CDP and MCP ready)', async () => {
    let health: any;
    for (let i = 0; i < 80; i++) { try { health = await (await fetch(base + '/api/health')).json(); if (health.ok) break; } catch {} await Bun.sleep(250); }
    assert(health?.cdp && health?.mcp, 'stack not healthy');
  });
  await check('unauthenticated /api/me and WebSocket rejected', async () => {
    assert((await fetch(base + '/api/me')).status === 401, 'me allowed');
    assert((await fetch(base + '/ws', { headers: { origin: origin!, upgrade: 'websocket' } })).status === 401, 'ws allowed');
  });
  await check('wrong Origin and missing CSRF header rejected', async () => {
    assert((await fetch(base + '/api/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json', 'x-tandem': '1' }, body: '{}' })).status === 403, 'wrong Origin accepted');
    assert((await fetch(base + '/api/login', { method: 'POST', headers: { origin: origin!, 'content-type': 'application/json' }, body: '{}' })).status === 403, 'missing CSRF accepted');
  });
  await check('agent bearer rejected on viewer routes', async () => {
    assert((await fetch(base + '/api/me', { headers: { authorization: `Bearer ${agent}` } })).status === 401, 'agent token accepted');
    assert((await fetch(base + '/ws', { headers: { authorization: `Bearer ${agent}`, origin: origin!, upgrade: 'websocket' } })).status === 401, 'agent socket accepted');
  });
  await check('login and cookie /api/me', async () => {
    const response = await viewerFetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, ...(process.env.TANDEM_TEST_TOTP_SECRET ? { totp: totp(process.env.TANDEM_TEST_TOTP_SECRET) } : {}) }) });
    assert(response.status === 200, `login status ${response.status}`); cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await viewerFetch('/api/me')).json() as any; assert(me.user === 'owner', 'me response'); sessionId = me.sessionId;
  });
  await check('viewer cookie rejected on MCP and wrong WS Origin rejected', async () => {
    assert((await viewerFetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401, 'cookie accepted for MCP');
    assert((await viewerFetch('/ws', { headers: { cookie, origin: 'https://evil.example', upgrade: 'websocket' } })).status === 403, 'wrong ws Origin allowed');
  });
  await check('WebSocket welcome contains control and page tabs', async () => {
    ws = new WebSocket(base!.replace(/^http/, 'ws') + '/ws', { headers: { cookie, origin: origin! } } as any); ws.binaryType = 'arraybuffer';
    ws.onmessage = e => { if (typeof e.data === 'string') messages.push(JSON.parse(e.data)); else frames.push(Buffer.from(e.data)); };
    await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error('WebSocket connection failed')); });
    send({ t: 'hello', viewport: { w: 1280, h: 800, dpr: 1 } });
    const welcome = await until(() => messages.find(m => m.t === 'welcome'), 'welcome');
    assert(welcome.sessionId === sessionId && Array.isArray(welcome.tabs), 'invalid welcome'); assert(welcome.control.controller === 'agent', 'initial control not agent');
  });
  await check('input refused while agent controls', async () => {
    const mark = messages.length; send({ t: 'input.text', targetId: 'irrelevant', text: 'throwaway' });
    await until(() => messages.slice(mark).find(m => m.t === 'error' && m.code === 'not_in_control'), 'input rejection');
  });
  await check('control.take gives human ownership', async () => { await controlled('human'); });
  let targetId = '';
  await check('tab.new appears with human provenance', async () => {
    const mark = messages.length; send({ t: 'tab.new', url: 'https://example.com' });
    const tab = await until(() => messages.slice(mark).filter(m => m.t === 'tabs').flatMap(m => m.tabs).find((t: any) => t.url.startsWith('https://example.com') && t.opener === 'human'), 'new human tab');
    targetId = tab.targetId; createdTabs.add(targetId);
  });
  await check('view receives a correctly encoded JPEG frame', async () => {
    send({ t: 'view', targetId });
    const frame = await until(() => frames.find(f => { try { return JSON.parse(f.subarray(4, 4 + f.readUInt32BE(0)).toString()).targetId === targetId; } catch { return false; } }), 'JPEG frame');
    const length = frame.readUInt32BE(0), meta = JSON.parse(frame.subarray(4, 4 + length).toString());
    assert(length > 0 && length < 10000 && meta.deviceWidth > 0 && meta.deviceHeight > 0 && meta.format === 'jpeg', 'invalid frame metadata');
    const jpeg = frame.subarray(4 + length); assert(jpeg[0] === 255 && jpeg[1] === 216 && jpeg.at(-2) === 255 && jpeg.at(-1) === 217, 'invalid JPEG');
  });
  await check('background tab view paints without activating the tab', async () => {
    const mark = messages.length;
    send({ t: 'tab.new', url: 'about:blank' });
    const state = await until(() => messages.slice(mark).find(m => m.t === 'tabs' && m.tabs.some((t: any) => t.targetId !== targetId && t.opener === 'human' && t.url === 'about:blank')), 'front tab');
    const other = state.tabs.find((t: any) => t.targetId !== targetId && t.opener === 'human' && t.url === 'about:blank'); createdTabs.add(other.targetId);
    const seq = (frame: Buffer) => { const h = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString()); return h.targetId === targetId ? h.seq : 0; };
    const firstSeq = Math.max(0, ...frames.map(seq)); send({ t: 'view', targetId });
    await until(() => frames.some(frame => seq(frame) > firstSeq), 'fresh background frame');
    assert(messages.filter(m => m.t === 'tabs').at(-1).activeTargetId !== targetId, 'view activated background tab');
  });
  await check('mouse, keyboard and inserted text dispatch without error', async () => {
    const mark = messages.length;
    send({ t: 'input.mouse', targetId, type: 'move', x: 10, y: 10 }); send({ t: 'input.mouse', targetId, type: 'down', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1 });
    send({ t: 'input.mouse', targetId, type: 'up', x: 10, y: 10, button: 'left', buttons: 0, clickCount: 1 });
    send({ t: 'input.key', targetId, type: 'down', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: 0 });
    send({ t: 'input.key', targetId, type: 'up', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0 }); send({ t: 'input.text', targetId, text: 'throwaway browser test' });
    await syncBrowser(); assert(!messages.slice(mark).some(m => m.t === 'error'), 'input dispatch error');
  });
  await check('nav.go, history back/forward and reload', async () => {
    let mark = messages.length; send({ t: 'nav.go', targetId, url: 'https://example.org' });
    await until(() => messages.slice(mark).filter(m => m.t === 'tabs').flatMap(m => m.tabs).find((t: any) => t.targetId === targetId && t.url.startsWith('https://example.org') && t.canGoBack), 'navigate and history'); await syncBrowser(); assert(!messages.slice(mark).some(m => m.t === 'error'), 'nav.go returned a command error');
    mark = messages.length; send({ t: 'nav.back', targetId });
    await until(() => messages.slice(mark).filter(m => m.t === 'tabs').flatMap(m => m.tabs).find((t: any) => t.targetId === targetId && t.url.startsWith('https://example.com') && t.canGoForward), 'back navigation'); assert(!messages.slice(mark).some(m => m.t === 'error'), 'back returned a command error');
    send({ t: 'nav.forward', targetId }); send({ t: 'nav.reload', targetId }); send({ t: 'nav.stop', targetId }); await syncBrowser();
  });
  await check('desktop framebuffer without control; VNC pointer/key only with control; release keeps stream open', async () => {
    const page = await viewerFetch('/desktop/vnc.html'); assert(page.status === 200 && (await page.text()).includes('noVNC'), 'noVNC file not proxied');
    await controlled('agent');
    const desktop = new WebSocket(base!.replace(/^http/, 'ws') + '/desktop/websockify', { headers: { cookie, origin: origin! }, protocols: ['binary'] } as any); desktop.binaryType = 'arraybuffer';
    const probe = new Cdp(process.env.TANDEM_TEST_CDP_URL ?? 'http://127.0.0.1:9110', () => false);
    let pending = Buffer.alloc(0), closed: number | undefined;
    desktop.onmessage = e => { pending = Buffer.concat([pending, Buffer.from(e.data)]); };
    desktop.onclose = e => { closed = e.code; };
    const read = async (size: number) => {
      await until(() => { assert(closed === undefined, `desktop closed ${closed}`); return pending.length >= size; }, `RFB ${size} bytes`);
      const value = pending.subarray(0, size); pending = pending.subarray(size); return value;
    };
    try {
      const banner = await read(12); assert(banner.toString() === 'RFB 003.008\n', 'RFB version'); desktop.send(banner);
      const count = (await read(1))[0]!; assert((await read(count)).includes(1), 'RFB None security unavailable');
      desktop.send(Buffer.from([1])); assert((await read(4)).readUInt32BE(0) === 0, 'RFB security failed'); desktop.send(Buffer.from([1]));
      const init = await read(24), width = init.readUInt16BE(0), height = init.readUInt16BE(2); await read(init.readUInt32BE(20));
      assert(width > 0 && height > 0, 'invalid ServerInit');
      const format = Buffer.alloc(20); format[4] = 32; format[5] = 24; format[7] = 1;
      format.writeUInt16BE(255, 8); format.writeUInt16BE(255, 10); format.writeUInt16BE(255, 12); format[14] = 16; format[15] = 8;
      desktop.send(format); desktop.send(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]));
      const update = async () => {
        desktop.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]));
        const header = await read(4); assert(header[0] === 0 && header.readUInt16BE(2) > 0, 'missing framebuffer update');
        let pixels = 0;
        for (let i = 0; i < header.readUInt16BE(2); i++) {
          const rect = await read(12); assert(rect.readInt32BE(8) === 0, 'expected raw framebuffer');
          const size = rect.readUInt16BE(4) * rect.readUInt16BE(6) * 4; await read(size); pixels += size;
        }
        assert(pixels > 0, 'empty framebuffer update');
      };
      await update();
      probe.start(); await until(() => probe.connected && probe.tabs.has(targetId), 'CDP input probe');
      const inputTarget = [...probe.tabs.values()].find(tab => createdTabs.has(tab.targetId) && tab.url === 'about:blank')?.targetId; assert(inputTarget, 'missing foreground input fixture');
      const evaluate = async (expression: string) => (await probe.page(inputTarget, 'Runtime.evaluate', { expression, returnByValue: true })).result.value;
      await controlled('human');
      await evaluate(`document.body.innerHTML = '<input id="vnc" style="position:fixed;inset:0;width:100vw;height:100vh">'; window.vncEvents = {mouse:0,key:0}; document.addEventListener('mousedown', () => window.vncEvents.mouse++); document.addEventListener('keydown', () => window.vncEvents.key++); document.querySelector('input').focus()`);
      const reset = () => evaluate(`document.querySelector('input').value = ''; window.vncEvents = {mouse:0,key:0}; document.querySelector('input').focus()`);
      const state = () => evaluate(`({value:document.querySelector('input').value, ...window.vncEvents})`);
      const input = (key: string, shift: number) => {
        const pointer = Buffer.from([5, 0, 0, 0, 0, 0]); pointer.writeUInt16BE(Math.floor(width * 0.7) + shift, 2); pointer.writeUInt16BE(Math.floor(height * 0.6), 4);
        const down = Buffer.from(pointer); down[1] = 1;
        const keydown = Buffer.from([4, 1, 0, 0, 0, 0, 0, key.charCodeAt(0)]), keyup = Buffer.from(keydown); keyup[1] = 0;
        desktop.send(Buffer.concat([pointer, down, pointer, keydown, keyup]));
      };
      await controlled('agent'); await reset(); input('b', 0); await update(); await Bun.sleep(250);
      assert(JSON.stringify(await state()) === JSON.stringify({ value: '', mouse: 0, key: 0 }), 'uncontrolled VNC input reached the page');
      await controlled('human'); input('a', 1);
      let typed: any;
      for (let i = 0; i < 100; i++) { typed = await state(); if (typed.value === 'a' && typed.mouse > 0 && typed.key > 0) break; await Bun.sleep(20); }
      assert(typed?.value === 'a' && typed.mouse > 0 && typed.key > 0, `controlled VNC input missing: ${JSON.stringify(typed)}`);
      await controlled('agent'); await reset(); input('c', 2); await update(); await Bun.sleep(250);
      const after = await state(); assert(after.value === '' && after.mouse === 0 && after.key === 0, 'VNC input passed after release');
      assert(closed === undefined && desktop.readyState === WebSocket.OPEN, 'release closed the desktop'); await controlled('human');
    } finally { desktop.close(); probe.close(); }
  });
  let tools: any[] = [];
  await check('MCP initialize and tools/list pass during manual control', async () => {
    const initialize = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'tandem-e2e', version: '0.1.0' } });
    protocol = initialize.result.protocolVersion;
    const response = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${agent}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': mcpSession, 'mcp-protocol-version': protocol }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert(response.ok, 'initialized failed'); await response.body?.cancel(); tools = (await rpc('tools/list')).result.tools;
    assert(tools.find(t => t.name === 'history')?.annotations?.readOnlyHint === true, 'history not read-only');
  });
  await check('annotated read-only MCP call succeeds during human control', async () => {
    const response = await rpc('tools/call', { name: 'history', arguments: { maxResults: 1 } }); assert(!response.result.isError, 'history failed');
  });
  await check('mutating MCP call held until control.release', async () => {
    const mark = messages.length; let done = false;
    const pending = rpc('tools/call', { name: 'tabs', arguments: { action: 'list' } }, 'held-release').then(value => { done = true; return value; });
    await until(() => messages.slice(mark).find(m => m.t === 'control' && m.pendingAgentCalls > 0), 'pending agent call');
    await Bun.sleep(100); assert(!done, 'mutating call was not held'); await controlled('agent'); const response = await pending;
    assert(response.id === 'held-release' && !response.result.isError, 'held call did not complete'); await controlled('human');
  });
  await check('mutating MCP timeout returns exact paused result and original id', async () => {
    const response = await rpc('tools/call', { name: 'tabs', arguments: { action: 'list' } }, 'held-timeout');
    assert(response.id === 'held-timeout' && response.result.isError === true && response.result.content[0].text === PAUSED_TEXT, 'wrong timeout result');
    await controlled('agent');
  });
  await check('agent-created tab emits agent.activity and agent provenance', async () => {
    const mark = messages.length; const before = new Set(messages.filter(m => m.t === 'tabs').at(-1)?.tabs.map((t: any) => t.targetId));
    const response = await rpc('tools/call', { name: 'tabs', arguments: { action: 'new', url: 'https://example.org' } }); assert(!response.result.isError, 'MCP tab new failed');
    const tab = await until(() => messages.slice(mark).filter(m => m.t === 'tabs').flatMap(m => m.tabs).find((t: any) => !before.has(t.targetId) && t.opener === 'agent' && t.url.startsWith('https://example.org')), 'agent tab'); createdTabs.add(tab.targetId);
    await until(() => messages.slice(mark).find(m => m.t === 'agent.activity' && m.targetId === tab.targetId), 'agent activity');
  });
  await check('audit excludes passwords, tokens, typed text and full URL paths', async () => {
    const response = await viewerFetch('/api/audit'); const text = await response.text();
    assert(!text.includes(password!) && !text.includes(agent!) && !text.includes('throwaway browser test'), 'audit leaked sensitive data');
    assert(text.includes('agent.denied') && text.includes('nav.go'), `missing audit events: ${JSON.parse(text).map((entry: any) => entry.event).join(', ')}`);
  });
  await check('test tabs close, logout closes viewer with 4401', async () => {
    await controlled('human');
    for (const targetId of createdTabs) send({ t: 'tab.close', targetId });
    await until(() => { const tabs = messages.filter(m => m.t === 'tabs').at(-1)?.tabs; return tabs && !tabs.some((t: any) => createdTabs.has(t.targetId)); }, 'test tab cleanup');
    const close = new Promise<number>(resolve => { ws!.onclose = event => resolve(event.code); });
    const response = await viewerFetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert(response.ok, 'logout failed'); assert(await close === 4401, 'logout close code');
  });
} catch {} finally {
  ws?.close();
  if (mcpSession) try { await fetch(base + '/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${agent}`, 'mcp-session-id': mcpSession, 'mcp-protocol-version': protocol }, signal: AbortSignal.timeout(5000) }); } catch {}
}
console.log(`${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
