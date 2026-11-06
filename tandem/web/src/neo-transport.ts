import type { KeyStroke } from './neo-input';
export type NeoTransport = 'WebRTC' | 'VNC';
// Unplanned reconnects retain their deadline; an intentional visibility pause starts a new guard.
export class TransportFallback {
  private firstFrame = false;
  private lostAt?: number;
  private ended = false;
  constructor(private startedAt: number) {}
  frame() { this.firstFrame = true; }
  connection(connected: boolean, now: number) {
    if (connected) this.lostAt = undefined;
    else this.lostAt ??= now;
  }
  expired(now: number) {
    if (!this.firstFrame && now - this.startedAt >= 8000 || this.lostAt !== undefined && now - this.lostAt >= 10000) this.ended = true;
    return this.ended;
  }
}
export type StreamPreference = 'smooth' | 'sharp';
interface StreamStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function readStream(storage: Pick<StreamStorage, 'getItem'>): StreamPreference {
  try { return storage.getItem('tandem.stream') === 'sharp' ? 'sharp' : 'smooth'; } catch { return 'smooth'; }
}
export function persistStream(stream: StreamPreference, storage: Pick<StreamStorage, 'setItem'>): void {
  try { storage.setItem('tandem.stream', stream); } catch { /* Optional preference. */ }
}
export const selectTransport = (enabled: unknown, fellBack: boolean, stream: StreamPreference = 'smooth'): NeoTransport =>
  stream === 'smooth' && enabled === true && !fellBack ? 'WebRTC' : 'VNC';
export function sendNekoKeys(input: { key(keysym: number, down: boolean): void }, sequence: KeyStroke[]) {
  for (const [key, , down] of sequence) input.key(key, down);
}
export interface Click { x: number; y: number; button: number; at: number }
export class ClickReplay {
  private click?: Click;
  queue(click: Click) { this.click = click; }
  clear() { this.click = undefined; }
  take(allowed: boolean, now: number) {
    if (this.click && now - this.click.at > 5000) this.clear();
    if (!allowed) return;
    const click = this.click; this.clear(); return click;
  }
}
export function replayNekoClick(input: { move(x: number, y: number): void; button(code: number, down: boolean): void }, click: Click,
  rect: { left: number; top: number; width: number; height: number }, screen: { width: number; height: number }) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const x = (click.x - rect.left) * screen.width / rect.width, y = (click.y - rect.top) * screen.height / rect.height;
  if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return;
  input.move(Math.round(x), Math.round(y));
  input.button(click.button + 1, true); input.button(click.button + 1, false);
}

export const HIDDEN_PAUSE_MS = 15000;
export interface PauseClock {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export class VisibilityPause {
  private timer?: ReturnType<typeof setTimeout>;
  private hidden = false;
  private paused = false;
  constructor(private changed: (paused: boolean) => void, private clock: PauseClock = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer) }) {}
  visibility(hidden: boolean) {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    if (hidden) this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.paused = true; this.changed(true); }, HIDDEN_PAUSE_MS);
    else if (this.paused) { this.paused = false; this.changed(false); }
  }
  stop() { if (this.timer !== undefined) this.clock.clearTimeout(this.timer); }
}
