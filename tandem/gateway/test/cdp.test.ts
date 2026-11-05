import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { Cdp } from '../src/cdp';

const cleanup: (() => void)[] = []; afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
async function until(fn: () => boolean, ms = 2000) { const start = Date.now(); while (!fn()) { if (Date.now() - start > ms) throw new Error('Timed out'); await Bun.sleep(5); } }
async function setup() {
  const calls: any[] = [], sockets = new Set<ServerWebSocket<unknown>>();
  let inactive = 0, fail = false;
  const server = Bun.serve({ port: 0, fetch(req, srv) {
    if (new URL(req.url).pathname === '/json/version') return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/cdp` });
    if (srv.upgrade(req)) return undefined; return new Response(null, { status: 404 });
  }, websocket: {
    open(ws) { sockets.add(ws); }, close(ws) { sockets.delete(ws); },
    message(ws, data) {
      const rpc = JSON.parse(String(data)); calls.push(rpc); let result: any = {};
      if (rpc.method === 'Target.setDiscoverTargets') ws.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'existing', type: 'page', url: 'https://example.com/', title: 'Existing' } } }));
      if (rpc.method === 'Target.getTargets') result = { targetInfos: [{ targetId: 'existing', type: 'page', url: 'https://example.com/', title: 'Existing' }, { targetId: 'ui', type: 'browser_ui', url: 'chrome://omnibox-popup', title: '' }] };
      if (rpc.method === 'Target.attachToTarget') result = { sessionId: `session-${rpc.params.targetId}` };
      if (rpc.method === 'Page.getNavigationHistory') result = { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      if (rpc.method === 'Target.createTarget') {
        result = { targetId: 'new-human' };
        ws.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: result.targetId, type: 'page', url: rpc.params.url, title: 'New' } } }));
      }
      let error;
      if (rpc.method === 'Input.insertText' && inactive-- > 0) error = { code: -32000, message: 'Not attached to an active page' };
      if (rpc.method === 'Input.insertText' && fail) error = { code: -32000, message: 'Other browser error' };
      ws.send(JSON.stringify({ id: rpc.id, sessionId: rpc.sessionId, ...(error ? { error } : { result }) }));
    },
  } }); cleanup.push(() => { for (const ws of sockets) ws.terminate(); void server.stop(true); server.unref(); });
  let agentControls = true;
  const cdp = new Cdp(`http://127.0.0.1:${server.port}`, () => agentControls); cleanup.push(() => cdp.close());
  const activity: any[] = [], dialogs: any[] = [];
  cdp.on('activity', value => activity.push(value)); cdp.on('dialog', value => dialogs.push(value)); cdp.start();
  await until(() => cdp.connected && cdp.tabs.has('existing'));
  await Bun.sleep(10);
  const event = (method: string, params: unknown, sessionId?: string) => { for (const ws of sockets) ws.send(JSON.stringify({ method, params, sessionId })); };
  return { cdp, calls, sockets, activity, dialogs, event, setHuman: () => { agentControls = false; }, setInactive: (n: number) => { inactive = n; }, setFailure: () => { fail = true; } };
}
test('discovers only page targets, existing tabs have unknown provenance and history state updates', async () => {
  const { cdp, activity } = await setup(); expect([...cdp.tabs.keys()]).toEqual(['existing']); expect(cdp.tabs.get('existing')?.opener).toBe('unknown'); expect(activity).toHaveLength(0);
  await cdp.history('existing'); expect(cdp.tabs.get('existing')).toMatchObject({ canGoBack: true, canGoForward: true });
});
test('agent activity ignores title-only changes, observes URL changes and creations', async () => {
  const { cdp, event, activity, setHuman } = await setup();
  event('Target.targetInfoChanged', { targetInfo: { targetId: 'existing', type: 'page', url: 'https://example.com/', title: 'Ticking price' } }); await Bun.sleep(10); expect(activity).toHaveLength(0);
  event('Target.targetInfoChanged', { targetInfo: { targetId: 'existing', type: 'page', url: 'https://example.org/', title: 'Other' } }); await until(() => activity.length === 1);
  event('Target.targetCreated', { targetInfo: { targetId: 'agent-tab', type: 'page', url: 'about:blank', title: '' } }); await until(() => activity.length === 2); expect(cdp.tabs.get('agent-tab')?.opener).toBe('agent');
  setHuman(); event('Target.targetInfoChanged', { targetInfo: { targetId: 'existing', type: 'page', url: 'https://example.net/', title: 'Human' } }); await Bun.sleep(10); expect(activity).toHaveLength(2);
});
test('viewer-created target is human even while an older agent call is finishing', async () => {
  const { cdp, activity } = await setup(); const tab = await cdp.newTab('example.org'); expect(cdp.tabs.get(tab.targetId)?.opener).toBe('human'); expect(activity).toHaveLength(0);
});
test('transient renderer swap is retried, other failures are not; control guard runs on retry', async () => {
  const { cdp, calls, setInactive, setFailure } = await setup(); setInactive(1);
  await cdp.page('existing', 'Input.insertText', { text: 'test' }); expect(calls.filter(c => c.method === 'Input.insertText')).toHaveLength(2);
  setInactive(1); let guards = 0;
  await expect(cdp.page('existing', 'Input.insertText', { text: 'test' }, () => { if (++guards === 2) throw new Error('lost control'); })).rejects.toThrow('lost control');
  const count = calls.length; setInactive(0); setFailure(); await expect(cdp.page('existing', 'Input.insertText', { text: 'test' })).rejects.toThrow(); expect(calls.length - count).toBe(1);
});
test('viewed-page lifecycle and JS dialogs are forwarded', async () => {
  const { cdp, event, dialogs } = await setup(); const sid = await cdp.session('existing');
  event('Page.lifecycleEvent', { name: 'init', frameId: 'main' }, sid); await until(() => cdp.tabs.get('existing')?.loading === true);
  event('Page.lifecycleEvent', { name: 'load', frameId: 'main' }, sid); await until(() => cdp.tabs.get('existing')?.loading === false);
  event('Page.javascriptDialogOpening', { type: 'prompt', message: 'Question', defaultPrompt: 'answer' }, sid); event('Page.javascriptDialogClosed', {}, sid);
  await until(() => dialogs.length === 2); expect(dialogs).toEqual([{ t: 'dialog', targetId: 'existing', type: 'prompt', message: 'Question', defaultPrompt: 'answer' }, { t: 'dialog.closed', targetId: 'existing' }]);
});
test('single browser connection reconnects after disconnect with fresh target discovery', async () => {
  const { cdp, calls, sockets } = await setup();
  for (const ws of sockets) ws.terminate(); await until(() => !cdp.connected); expect(cdp.tabs.size).toBe(0);
  await until(() => cdp.connected && cdp.tabs.has('existing')); expect(calls.filter(c => c.method === 'Target.setDiscoverTargets')).toHaveLength(2); expect(sockets.size).toBe(1);
});
