import { expect, test } from 'bun:test';
import { BuildWatch } from '../src/update';

const watch = () => {
  const log: string[] = [];
  return { log, w: new BuildWatch(() => log.push('reload'), () => log.push('deferred')) };
};

test('the first build is remembered; the same build again does nothing', () => {
  const { log, w } = watch();
  w.welcome('a', false); w.welcome('a', false); w.welcome(undefined, false);
  expect(log).toEqual([]);
});
test('a new build reloads a viewer that is not driving', () => {
  const { log, w } = watch();
  w.welcome('a', false); w.welcome('b', false);
  expect(log).toEqual(['reload']);
});
test('a new build waits while driving and reloads once control is handed back', () => {
  const { log, w } = watch();
  w.welcome('a', true); w.welcome('b', true); w.welcome('b', true);
  expect(log).toEqual(['deferred']);
  w.control(true); expect(log).toEqual(['deferred']);
  w.control(false); expect(log).toEqual(['deferred', 'reload']);
});
