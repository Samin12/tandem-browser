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
let ws: WebSocket | undefined, nekoWs: WebSocket | undefined, agentWs: WebSocket | undefined;
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
  await check('CDP bad token rejected and extra HTTP endpoints blocked', async () => {
    const bad = await fetch(base + '/cdp/wrong/json/version');
    assert(bad.status === 401 && (await bad.json() as any).error === 'unauthorized', 'CDP bad auth differs from MCP');
    assert((await fetch(base + `/cdp/${agent}/json/new`)).status === 404, 'CDP new exposed');
  });
  await check('CDP discovery URL connects, creates, evaluates and closes a target; human hold releases in order', async () => {
    const response = await fetch(base + `/cdp/${agent}/json/version/`); assert(response.ok, 'CDP discovery failed (Playwright trailing slash)');
    const version = await response.json() as any;
    assert(version.webSocketDebuggerUrl.startsWith(origin!.replace(/^http/, 'ws') + `/cdp/${agent}/devtools/browser/`), 'CDP debugger URL not rewritten');
    const received: any[] = [];
    agentWs = new WebSocket(version.webSocketDebuggerUrl);
    agentWs.onmessage = event => received.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { agentWs!.onopen = () => resolve(); agentWs!.onerror = () => reject(new Error('CDP socket failed')); });
    let id = 0, target: string | undefined;
    const call = async (method: string, params = {}, sessionId?: string) => {
      const seq = ++id; agentWs!.send(JSON.stringify({ id: seq, method, params, sessionId }));
      const value = await until(() => received.find(v => v.id === seq), 'CDP ' + method);
      assert(!value.error, 'CDP command failed: ' + method); return value.result;
    };
    try {
      target = (await call('Target.createTarget', { url: 'about:blank' })).targetId;
      const { sessionId } = await call('Target.attachToTarget', { targetId: target, flatten: true });
      assert((await call('Runtime.evaluate', { expression: '6 * 7', returnByValue: true }, sessionId)).result.value === 42, 'CDP evaluate failed');
      await controlled('human');
      let done = false;
      const pending = call('Runtime.evaluate', { expression: '21 * 2', returnByValue: true }, sessionId).then(value => { done = true; return value; });
      await until(() => messages.filter(m => m.t === 'control').at(-1)?.pendingAgentCalls > 0, 'CDP held state');
      await call('Browser.getVersion'); await Bun.sleep(100); assert(!done, 'CDP mutation bypassed manual control');
      await controlled('agent'); assert((await pending).result.value === 42, 'held evaluate failed after release');
    } finally {
      if (messages.filter(m => m.t === 'control').at(-1)?.controller === 'human') await controlled('agent');
      if (target) await call('Target.closeTarget', { targetId: target });
      agentWs.close(); agentWs = undefined;
    }
  });
  await check('input refused while agent controls', async () => {
    const mark = messages.length; send({ t: 'input.text', targetId: 'irrelevant', text: 'throwaway' });
    await until(() => messages.slice(mark).find(m => m.t === 'error' && m.code === 'not_in_control'), 'input rejection');
  });
  await check('control.take gives human ownership', async () => { await controlled('human'); });
  if (process.env.TANDEM_TEST_NEKO === '1') {
    const nekoBase = process.env.TANDEM_TEST_NEKO_URL ?? 'http://127.0.0.1:8080';
    const nekoApiToken = process.env.TANDEM_TEST_NEKO_API_TOKEN ?? 'tandem-local-neko-api-token-000000000000';
    const nekoAdmin = async (path: string) => {
      const response = await fetch(nekoBase + '/api' + path, { headers: { authorization: `Bearer ${nekoApiToken}` }, signal: AbortSignal.timeout(5000) });
      assert(response.ok, `neko admin status ${response.status}`); return await response.json() as any;
    };
    await check('WebRTC availability and blocked neko routes', async () => {
      assert((await (await viewerFetch('/api/me')).json() as any).webrtc === true, 'WebRTC not healthy');
      assert((await viewerFetch('/neko/metrics')).status === 404, 'neko metrics exposed');
      assert((await viewerFetch('/neko/api/room/control')).status === 404, 'neko control exposed');
      assert((await fetch(base + '/neko/api/ws', { headers: { origin: origin!, upgrade: 'websocket' } })).status === 401, 'anonymous neko upgrade accepted');
    });
    let nekoId = '';
    await check('authenticated neko WebSocket upgrades and receives system/init without credentials', async () => {
      const response = await fetch(base + '/neko/api/whoami', { headers: { cookie } });
      assert(response.ok, 'same-origin neko reconnect check requires no Origin');
      const me = await response.json() as any; nekoId = me.id;
      assert(typeof nekoId === 'string' && !('token' in me), 'invalid neko viewer identity');
      const received: any[] = [];
      nekoWs = new WebSocket(base!.replace(/^http/, 'ws') + '/neko/api/ws', { headers: { cookie, origin: origin! } } as any);
      nekoWs.onmessage = event => { if (typeof event.data === 'string') received.push(JSON.parse(event.data)); };
      await new Promise<void>((resolve, reject) => { nekoWs!.onopen = () => resolve(); nekoWs!.onerror = () => reject(new Error('neko upgrade failed')); });
      await until(() => received.find(m => m.event === 'system/init'), 'neko system/init');
      assert(!JSON.stringify(received).includes(nekoApiToken), 'admin credential leaked');
    });
    await check('Tandem control maps to neko host and release resets host', async () => {
      const hostIs = async (id?: string) => {
        for (let i = 0; i < 100; i++) { const state = await nekoAdmin('/room/control'); if (id ? state.host_id === id : !state.has_host) return; await Bun.sleep(50); }
        throw new Error('neko host did not match Tandem');
      };
      await hostIs(nekoId); await controlled('agent'); await hostIs();
      await controlled('human'); await hostIs(nekoId);
      const settings = await nekoAdmin('/room/settings');
      assert(settings.locked_controls === true && settings.implicit_hosting === false && settings.control_protection === false, 'unsafe neko room settings');
    });
    await check('viewer screen message resizes the real display (CDP device pixels)', async () => {
      const probe = new Cdp(process.env.TANDEM_TEST_CDP_URL ?? 'http://127.0.0.1:9110', () => false);
      probe.start();
      try {
        await until(() => probe.connected && probe.tabs.size > 0, 'CDP screen probe');
        const target = [...probe.tabs.keys()][0]!;
        const size = async () => (await probe.page(target, 'Runtime.evaluate', { expression: '({w:Math.round(screen.width*devicePixelRatio),h:Math.round(screen.height*devicePixelRatio)})', returnByValue: true })).result.value;
        const before = await size(), w = before.w === 1280 ? 1440 : 1280, h = 800;
        send({ t: 'screen', w, h });
        let resized = false;
        try {
          for (let i = 0; i < 100; i++) { const current = await size(); if (current.w === w && current.h === h) { resized = true; break; } await Bun.sleep(100); }
          assert(resized, 'real display size did not change');
        } finally {
          send({ t: 'screen', w: before.w, h: before.h });
          for (let i = 0; i < 100; i++) { const current = await size(); if (current.w === before.w && current.h === before.h) break; await Bun.sleep(100); }
        }
      } finally { probe.close(); }
    });
  }
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
  await check('quickack MCP tabs latency stays below 30 ms median', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const began = performance.now(), response = await rpc('tools/call', { name: 'tabs', arguments: { action: 'list' } });
      const elapsed = performance.now() - began; assert(!response.result.isError, 'MCP tabs failed');
      if (i >= 5) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    const median = (samples[9]! + samples[10]!) / 2;
    console.log(`MCP tabs (20 samples, 5 warmup): median ${median.toFixed(2)} ms, min ${samples[0]!.toFixed(2)} ms, p95 ${samples[18]!.toFixed(2)} ms`);
    assert(median < 30, 'MCP tabs median exceeds 30 ms');
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
  ws?.close(); nekoWs?.close(); agentWs?.close();
  if (mcpSession) try { await fetch(base + '/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${agent}`, 'mcp-session-id': mcpSession, 'mcp-protocol-version': protocol }, signal: AbortSignal.timeout(5000) }); } catch {}
}
console.log(`${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
