import { expect, test } from 'bun:test';
import type { Cdp } from '../src/cdp';
import type { Control } from '../src/control';
import { Follow } from '../src/follow';

function setup() {
  const calls: { targetId: string; at: number }[] = [], control = { controller: 'agent' };
  const follow = new Follow({ activate: async (targetId: string) => { calls.push({ targetId, at: Date.now() }); } } as Cdp, control as Control);
  return { follow, calls, control };
}
test('follow uses any enabled socket, throttles to 500 ms with the trailing target winning', async () => {
  const { follow, calls } = setup(), a = {}, b = {};
  try {
    follow.activity('off'); expect(calls).toHaveLength(0);
    follow.set(a, true); follow.set(b, true); follow.set(a, false);
    follow.activity('first'); follow.activity('middle'); follow.activity('last');
    expect(calls.map(c => c.targetId)).toEqual(['first']); await Bun.sleep(550);
    expect(calls.map(c => c.targetId)).toEqual(['first', 'last']); expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(500);
    follow.set(b, false); follow.activity('off'); expect(calls).toHaveLength(2);
  } finally { follow.close(); }
});
test('human takeover cancels pending follow and never replays stale activity on release', async () => {
  const { follow, calls, control } = setup(), a = {};
  try {
    follow.set(a, true); follow.activity('first'); follow.activity('pending');
    control.controller = 'human'; follow.changed(); follow.activity('human');
    await Bun.sleep(550); expect(calls.map(c => c.targetId)).toEqual(['first']);
    control.controller = 'agent'; follow.changed(); expect(calls).toHaveLength(1);
    follow.activity('resumed'); expect(calls.map(c => c.targetId)).toEqual(['first', 'resumed']);
    follow.activity('disconnected'); follow.set(a, false); await Bun.sleep(550); expect(calls).toHaveLength(2);
  } finally { follow.close(); }
});
