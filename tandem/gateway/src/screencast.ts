import type { Cdp } from './cdp';

export interface FrameHeader {
  targetId: string; seq: number; deviceWidth: number; deviceHeight: number; offsetTop: number;
  pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number; timestamp: number; format: 'jpeg';
}
export interface FrameSink { getBufferedAmount(): number; send(data: Uint8Array): unknown }
export function encodeFrame(header: FrameHeader, jpeg: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const frame = Buffer.alloc(4 + json.length + jpeg.length);
  frame.writeUInt32BE(json.length); json.copy(frame, 4); frame.set(jpeg, 4 + json.length); return frame;
}
interface Stream {
  subscribers: Map<FrameSink, { w: number; h: number; dpr: number }>;
  latest?: Buffer; seq: number; lastFrameAt: number; starting: boolean; polling: boolean;
  dimensions: string; timer?: ReturnType<typeof setInterval>; generation: number;
}
export class Screencasts {
  private streams = new Map<string, Stream>();
  private operations = new Map<string, Promise<void>>();
  constructor(private cdp: Cdp) {
    cdp.on('event', (method, params, targetId, sessionId) => {
      if (method !== 'Page.screencastFrame') return;
      // Ack even if nobody remains subscribed.
      void cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sessionId).catch(() => {});
      const stream = this.streams.get(targetId); if (!stream) return;
      stream.lastFrameAt = Date.now(); this.frame(targetId, stream, params.metadata, params.data);
    });
    cdp.on('disconnected', () => { for (const s of this.streams.values()) { s.generation++; s.starting = false; s.latest = undefined; s.dimensions = ''; } });
    cdp.on('connected', () => { for (const [id, s] of this.streams) void this.start(id, s); });
    cdp.on('target.closed', id => this.removeTarget(id));
    cdp.on('target.detached', id => { const s = this.streams.get(id); if (s) { s.dimensions = ''; void this.start(id, s); } });
  }
  subscribe(targetId: string, sink: FrameSink, viewport: { w: number; h: number; dpr: number }) {
    if (!this.cdp.tabs.has(targetId)) throw new Error('Unknown tab');
    for (const [id, stream] of this.streams) if (id !== targetId && stream.subscribers.has(sink)) this.unsubscribe(sink);
    let stream = this.streams.get(targetId);
    if (!stream) {
      stream = { subscribers: new Map(), seq: 0, lastFrameAt: 0, starting: false, polling: false, dimensions: '', generation: 0 };
      this.streams.set(targetId, stream);
      const s = stream;
      s.timer = setInterval(() => {
        if (!this.cdp.connected || s.starting) return;
        if (!s.dimensions) void this.start(targetId, s);
        if (Date.now() - s.lastFrameAt >= 1000 && !s.polling) void this.capture(targetId, s);
      }, 250);
    }
    stream.subscribers.set(sink, viewport);
    if (stream.latest && sink.getBufferedAmount() <= 2 * 1024 * 1024) sink.send(stream.latest);
    void this.start(targetId, stream);
    void this.cdp.history(targetId).catch(() => {});
  }
  viewport(sink: FrameSink, viewport: { w: number; h: number; dpr: number }) {
    for (const [id, stream] of this.streams) if (stream.subscribers.has(sink)) { stream.subscribers.set(sink, viewport); void this.start(id, stream); }
  }
  unsubscribe(sink: FrameSink) {
    for (const [id, stream] of this.streams) {
      if (!stream.subscribers.delete(sink)) continue;
      if (stream.subscribers.size) void this.start(id, stream);
      else {
        this.removeTarget(id);
        void this.enqueue(id, async () => {
          if (!this.cdp.connected || !this.cdp.tabs.has(id)) return;
          await this.cdp.page(id, 'Page.stopScreencast');
          await this.cdp.page(id, 'Emulation.setFocusEmulationEnabled', { enabled: false });
        }).catch(() => {});
      }
    }
  }
  private removeTarget(id: string) { const s = this.streams.get(id); if (s) { s.generation++; clearInterval(s.timer); this.streams.delete(id); } }
  private size(s: Stream) {
    return { maxWidth: Math.min(2560, Math.max(1, ...[...s.subscribers.values()].map(v => Math.round(v.w * v.dpr)))),
      maxHeight: Math.min(1600, Math.max(1, ...[...s.subscribers.values()].map(v => Math.round(v.h * v.dpr)))) };
  }
  private enqueue(id: string, operation: () => Promise<void>) {
    const next = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.operations.set(id, next);
    void next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id); }).catch(() => {});
    return next;
  }
  private async start(id: string, s: Stream) {
    if (s.starting || !this.cdp.connected || !s.subscribers.size) return;
    const size = this.size(s), dimensions = JSON.stringify(size);
    if (dimensions === s.dimensions) return;
    s.starting = true;
    const generation = s.generation;
    const guard = () => { if (this.streams.get(id) !== s || generation !== s.generation) throw new Error('Subscription ended'); };
    try {
      await this.enqueue(id, async () => {
        guard();
        await this.cdp.page(id, 'Emulation.setFocusEmulationEnabled', { enabled: true }, guard);
        if (s.dimensions) await this.cdp.page(id, 'Page.stopScreencast', {}, guard);
        guard();
        await this.cdp.page(id, 'Page.startScreencast', { format: 'jpeg', quality: 70, ...size, everyNthFrame: 1 }, guard);
        s.dimensions = dimensions; s.lastFrameAt = Date.now();
      });
    } catch { s.dimensions = ''; }
    finally { s.starting = false; }
    if (this.streams.get(id) === s && s.dimensions && dimensions !== JSON.stringify(this.size(s))) void this.start(id, s);
  }
  private frame(id: string, s: Stream, meta: any, data: string) {
    if (this.streams.get(id) !== s) return;
    const frame = encodeFrame({ targetId: id, seq: ++s.seq, deviceWidth: meta.deviceWidth, deviceHeight: meta.deviceHeight,
      offsetTop: meta.offsetTop ?? 0, pageScaleFactor: meta.pageScaleFactor ?? 1, scrollOffsetX: meta.scrollOffsetX ?? 0,
      scrollOffsetY: meta.scrollOffsetY ?? 0, timestamp: meta.timestamp ?? Date.now() / 1000, format: 'jpeg' }, Buffer.from(data, 'base64'));
    s.latest = frame;
    for (const sink of s.subscribers.keys()) if (sink.getBufferedAmount() <= 2 * 1024 * 1024) sink.send(frame);
  }
  private async capture(id: string, s: Stream) {
    s.polling = true; const started = Date.now();
    try {
      const { cssLayoutViewport, layoutViewport } = await this.cdp.page(id, 'Page.getLayoutMetrics');
      const viewport = cssLayoutViewport ?? layoutViewport;
      if (this.streams.get(id) !== s || s.lastFrameAt > started) return;
      const { data } = await this.cdp.page(id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, fromSurface: true,
        clip: { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight,
          scale: Math.min(1, this.size(s).maxWidth / viewport.clientWidth, this.size(s).maxHeight / viewport.clientHeight) } });
      if (s.lastFrameAt > started) return;
      this.frame(id, s, { deviceWidth: viewport.clientWidth, deviceHeight: viewport.clientHeight, offsetTop: 0, pageScaleFactor: 1,
        scrollOffsetX: viewport.pageX, scrollOffsetY: viewport.pageY, timestamp: Date.now() / 1000 }, data);
    } catch {} finally { s.polling = false; }
  }
  close() { for (const id of this.streams.keys()) this.removeTarget(id); }
}
