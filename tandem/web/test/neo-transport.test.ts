import { expect, test } from 'bun:test';
import { ClickReplay, replayNekoClick, selectTransport, sendNekoKeys, TransportFallback, VisibilityPause, HIDDEN_PAUSE_MS } from '../src/neo-transport';
import { commandShortcut, shortcutSequence } from '../src/neo-input';
import { remoteSize } from '../src/neo-resize';

test('WebRTC is opt-in and fallback stays VNC for this page load', () => {
  expect(selectTransport(true, false)).toBe('WebRTC');
  for (const enabled of [false, undefined, 'true', 1]) expect(selectTransport(enabled, false)).toBe('VNC');
  expect(selectTransport(true, true)).toBe('VNC');
});
test('socket/ICE alone do not satisfy the eight-second decoded-frame deadline', () => {
  const guard = new TransportFallback(1000);
  guard.connection(true, 2000);
  expect(guard.expired(8999)).toBe(false);
  expect(guard.expired(9000)).toBe(true);
  guard.frame(); expect(guard.expired(9001)).toBe(true);
});
test('a decoded frame cancels the initial deadline; ICE gets ten continuous seconds to recover', () => {
  const guard = new TransportFallback(0);
  guard.frame(); guard.connection(true, 1);
  expect(guard.expired(100000)).toBe(false);
  guard.connection(false, 100001); guard.connection(false, 105000);
  expect(guard.expired(110000)).toBe(false);
  guard.connection(true, 110000);
  expect(guard.expired(120000)).toBe(false);
  guard.connection(false, 120001);
  expect(guard.expired(130000)).toBe(false);
  expect(guard.expired(130001)).toBe(true);
});
test('screen messages use engine scale, even dimensions and both maximum dimensions', () => {
  expect({ t: 'screen', ...remoteSize({ w: 1440, h: 862 }, 2) }).toEqual({ t: 'screen', w: 2880, h: 1724 });
  for (const css of [{ w: 5000, h: 1000 }, { w: 1000, h: 5000 }, { w: 2560, h: 1440 }]) {
    const size = remoteSize(css, 2);
    expect(size.w).toBeLessThanOrEqual(3840); expect(size.h).toBeLessThanOrEqual(2400);
    expect(size.w % 2).toBe(0); expect(size.h % 2).toBe(0);
    expect(Math.abs(size.w / size.h - css.w / css.h)).toBeLessThan(0.02);
  }
});
test('all desktop browser/edit commands go through neko key API in balanced order', () => {
  const commands = ['new-tab', 'close-tab', 'focus-address', 'reload', 'stop', 'back', 'forward', 'next-tab', 'prev-tab',
    ...Array.from({ length: 9 }, (_, i) => `select-tab:${i + 1}`), 'edit-undo', 'edit-redo', 'edit-cut', 'edit-copy', 'edit-paste', 'edit-select-all'];
  for (const command of commands) {
    const sent: [number, boolean][] = [];
    const sequence = shortcutSequence(commandShortcut(command)!);
    sendNekoKeys({ key: (key, down) => sent.push([key, down]) }, sequence);
    expect(sent).toEqual(sequence.map(([key, , down]) => [key, down]));
  }
  const sent: [number, boolean][] = [];
  sendNekoKeys({ key: (key, down) => sent.push([key, down]) }, shortcutSequence(commandShortcut('prev-tab')!));
  expect(sent).toEqual([[65507, true], [65505, true], [65289, true], [65289, false], [65505, false], [65507, false]]);
});
test('takeover click waits for Tandem and neko readiness, replays once in remote pixels', () => {
  const pending = new ClickReplay(), events: unknown[] = [];
  const click = { x: 350, y: 240, button: 0, at: 1000 };
  pending.queue(click);
  expect(pending.take(false, 1100)).toBeUndefined();
  expect(pending.take(false, 1200)).toBeUndefined();
  const replay = pending.take(true, 1300)!;
  replayNekoClick({ move: (x, y) => events.push(['move', x, y]), button: (button, down) => events.push(['button', button, down]) },
    replay, { left: 100, top: 40, width: 1000, height: 500 }, { width: 2000, height: 1000 });
  expect(events).toEqual([['move', 500, 400], ['button', 1, true], ['button', 1, false]]);
  expect(pending.take(true, 1400)).toBeUndefined();
});
test('expired, cancelled and letterbox clicks do not reach the remote', () => {
  const pending = new ClickReplay();
  pending.queue({ x: 0, y: 0, button: 2, at: 0 }); expect(pending.take(true, 5001)).toBeUndefined();
  pending.queue({ x: 0, y: 0, button: 2, at: 0 }); pending.clear(); expect(pending.take(true, 1)).toBeUndefined();
  const events: unknown[] = [];
  replayNekoClick({ move: () => events.push('move'), button: () => events.push('button') }, { x: 0, y: 0, button: 2, at: 0 },
    { left: 100, top: 100, width: 500, height: 500 }, { width: 1000, height: 1000 });
  expect(events).toEqual([]);
});

test('hidden viewers pause after 15 seconds, resume immediately and cancel short hides', () => {
  let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>(), states: boolean[] = [];
  const advance = (ms: number) => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.run(); } };
  const pause = new VisibilityPause(value => states.push(value), {
    setTimeout: (run, ms) => { const id = ++sequence; timers.set(id, { at: now + ms, run }); return id as any; },
    clearTimeout: id => { timers.delete(id as any); },
  });
  pause.visibility(true); advance(HIDDEN_PAUSE_MS - 1); expect(states).toEqual([]);
  pause.visibility(false); advance(1); expect(states).toEqual([]);
  pause.visibility(true); advance(HIDDEN_PAUSE_MS); expect(states).toEqual([true]);
  pause.visibility(true); advance(60000); expect(states).toEqual([true]);
  pause.visibility(false); expect(states).toEqual([true, false]);
  pause.visibility(true); pause.stop(); advance(HIDDEN_PAUSE_MS); expect(states).toEqual([true, false]);
});
test('an intentional pause suppresses fallback and resume gets a fresh decoded-frame deadline', () => {
  let now = 0, paused = false, guard = new TransportFallback(now);
  let fire = () => {};
  const visibility = new VisibilityPause(value => { paused = value; if (!value) guard = new TransportFallback(now); }, {
    setTimeout: run => { fire = run; return 1 as any; }, clearTimeout: () => {},
  });
  guard.frame(); visibility.visibility(true); now = HIDDEN_PAUSE_MS; fire();
  now += 100000; expect(!paused && guard.expired(now)).toBe(false);
  visibility.visibility(false); guard.connection(true, now);
  expect(guard.expired(now + 7999)).toBe(false); expect(guard.expired(now + 8000)).toBe(true);
});

test('default visibility clock calls browser timers without an object receiver', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let scheduled = false, cancelled = false;
  try {
    globalThis.setTimeout = function(this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      scheduled = true; return 1 as any;
    } as any;
    globalThis.clearTimeout = function(this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      cancelled = true;
    } as any;
    const pause = new VisibilityPause(() => {});
    pause.visibility(true); pause.visibility(false); pause.stop();
    expect(scheduled).toBe(true); expect(cancelled).toBe(true);
  } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
