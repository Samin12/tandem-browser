import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { encodeFrame, Screencasts, type FrameHeader } from '../src/screencast';
import type { Cdp } from '../src/cdp';
const cleanup: (() => void)[] = []; afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const header: FrameHeader = { targetId: 'tab', seq: 7, deviceWidth: 1600, deviceHeight: 913, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 10, timestamp: 100, format: 'jpeg' };
test('frame uses big-endian header byte length followed by JSON and unchanged JPEG', () => {
  const jpeg = Buffer.from([255, 216, 255, 217]); const frame = encodeFrame({ ...header, targetId: 'tab-é' }, jpeg);
  const length = frame.readUInt32BE(0); expect(length).toBe(Buffer.byteLength(JSON.stringify({ ...header, targetId: 'tab-é' })));
  expect(JSON.parse(frame.subarray(4, 4 + length).toString())).toEqual({ ...header, targetId: 'tab-é' }); expect(frame.subarray(4 + length)).toEqual(jpeg);
});
function setup() {
  const calls: any[] = [];
  const fake = Object.assign(new EventEmitter(), { connected: true, tabs: new Map([['tab', {}]]),
    async page(target: string, method: string, params: any) {
      calls.push({ target, method, params });
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 3, pageY: 4, clientWidth: 1600, clientHeight: 913 } };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from([255, 216, 255, 217]).toString('base64') };
      return {};
    }, async history() {}, async send(method: string, params: any) { calls.push({ method, params }); } });
  const manager = new Screencasts(fake as unknown as Cdp); cleanup.push(() => manager.close());
  const sink = (buffered = 0) => { const frames: Uint8Array[] = []; return { frames, getBufferedAmount: () => buffered, send: (data: Uint8Array) => { frames.push(data); } }; };
  return { fake, calls, manager, sink };
}
test('shared subscriptions, focus emulation, cap, immediate ack, backpressure and latest frame', async () => {
  const { fake, calls, manager, sink } = setup(); const a = sink(), b = sink(3 * 1024 * 1024), c = sink();
  manager.subscribe('tab', a, { w: 2000, h: 1000, dpr: 2 }); manager.subscribe('tab', b, { w: 1000, h: 500, dpr: 1 }); await Bun.sleep(5);
  expect(calls.filter(c => c.method === 'Page.startScreencast')).toHaveLength(1);
  expect(calls.find(c => c.method === 'Page.startScreencast').params).toMatchObject({ maxWidth: 2560, maxHeight: 1600, quality: 70 });
  expect(calls[0]).toMatchObject({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
  fake.emit('event', 'Page.screencastFrame', { sessionId: 12, metadata: header, data: Buffer.from([255, 216, 255, 217]).toString('base64') }, 'tab', 'cdp-session');
  expect(calls.at(-1)).toMatchObject({ method: 'Page.screencastFrameAck', params: { sessionId: 12 } }); expect(a.frames).toHaveLength(1); expect(b.frames).toHaveLength(0);
  manager.subscribe('tab', c, { w: 100, h: 100, dpr: 1 }); expect(c.frames).toHaveLength(1);
  manager.unsubscribe(a); await Bun.sleep(5); expect(calls.filter(c => c.method === 'Page.stopScreencast')).toHaveLength(1);
  manager.unsubscribe(b); manager.unsubscribe(c); await Bun.sleep(5); expect(calls.some(c => c.method === 'Emulation.setFocusEmulationEnabled' && c.params.enabled === false)).toBe(true);
});
test('stalled screencast falls back to screenshots every 250 ms and stops after unsubscribe', async () => {
  const { calls, manager, sink } = setup(); const a = sink(); manager.subscribe('tab', a, { w: 800, h: 600, dpr: 1 });
  await Bun.sleep(1550); expect(calls.filter(c => c.method === 'Page.captureScreenshot').length).toBeGreaterThanOrEqual(2); expect(a.frames.length).toBeGreaterThanOrEqual(2);
  const frame = Buffer.from(a.frames[0]!); const meta = JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString()); expect(meta.deviceWidth).toBe(1600); expect(meta.scrollOffsetY).toBe(4);
  manager.unsubscribe(a); const count = calls.filter(c => c.method === 'Page.captureScreenshot').length; await Bun.sleep(300); expect(calls.filter(c => c.method === 'Page.captureScreenshot')).toHaveLength(count);
});
