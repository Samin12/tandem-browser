import type { KeyStroke } from './neo-input';
export type NeoTransport = 'WebRTC' | 'VNC';
// A page load gets one WebRTC attempt. Reconnecting never resets the deadline.
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
export const selectTransport = (enabled: unknown, fellBack: boolean): NeoTransport => enabled === true && !fellBack ? 'WebRTC' : 'VNC';
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
