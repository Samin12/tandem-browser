import { expect, test } from 'bun:test';
import { commandRoute, editCommands, selectedTabIndex } from '../src/commands';
for (const command of editCommands) test(`${command} targets address field only while it has focus`, () => {
  expect(commandRoute(command,true)).toBe('address'); expect(commandRoute(command,false)).toBe('remote');
});
test('all native browser commands bypass edit routing', () => {
  for (const command of ['new-tab','close-tab','focus-address','reload','stop','back','forward','next-tab','prev-tab','select-tab:1','select-tab:9','take-control','release-control','mode-watch','mode-agent','mode-manual','open-desktop-view','show-audit','logout']) {
    expect(commandRoute(command,true)).toBe('browser'); expect(commandRoute(command,false)).toBe('browser');
  }
});
test('tab shortcuts wrap; 9 means last, missing indices clamp', () => {
  expect(selectedTabIndex('next-tab',2,3)).toBe(0); expect(selectedTabIndex('prev-tab',0,3)).toBe(2);
  expect(selectedTabIndex('select-tab:1',2,3)).toBe(0); expect(selectedTabIndex('select-tab:9',0,12)).toBe(11);
  expect(selectedTabIndex('select-tab:8',0,3)).toBe(2); expect(selectedTabIndex('next-tab',0,0)).toBeNull();
  expect(selectedTabIndex('select-tab:0',0,3)).toBeNull(); expect(selectedTabIndex('reload',0,3)).toBeNull();
});
