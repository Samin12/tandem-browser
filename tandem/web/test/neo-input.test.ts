import { expect, test } from 'bun:test';
import { commandShortcut, keysym, macKeyRoute, macKeySequence, shortcutSequence, viewOnly } from '../src/neo-input';
const event = (key: string, shiftKey = false, altKey = false) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: true, ctrlKey: false, shiftKey, altKey });
test('Mac command maps to balanced Linux Control and lowercase Latin-1 keysyms', () => {
  expect(macKeySequence(event('T'))).toEqual([[0xffe3,'ControlLeft',true],[116,'KeyT',true],[116,'KeyT',false],[0xffe3,'ControlLeft',false]]);
  expect(keysym('é')).toBe(233); expect(keysym('Escape')).toBe(0xff1b); expect(keysym('日本語')).toBeUndefined();
});
test('Mac command preserves Shift and Alt with reverse modifier release', () => {
  expect(macKeySequence(event('T', true, true))).toEqual([
    [0xffe3,'ControlLeft',true],[0xffe1,'ShiftLeft',true],[0xffe9,'AltLeft',true],
    [116,'KeyT',true],[116,'KeyT',false],
    [0xffe9,'AltLeft',false],[0xffe1,'ShiftLeft',false],[0xffe3,'ControlLeft',false],
  ]);
});
test('Mac Option dead keys retain their physical shortcut letter', () => {
  expect(macKeySequence({ ...event('i', false, true), key:'Dead' })).toContainEqual([105, 'KeyI', true]);
});
test('paste uses the clipboard route; OS shortcuts and Meta stay local', () => {
  expect(macKeyRoute(event('v'))).toBe('paste'); expect(macKeySequence(event('v'))).toEqual([]);
  for (const key of ['q','Q','h','m','`','Meta']) {
    expect(macKeyRoute(key === 'Meta' ? { ...event(key), code:'MetaLeft' } : event(key))).toBe('local'); expect(macKeySequence(key === 'Meta' ? { ...event(key), code:'MetaLeft' } : event(key))).toEqual([]);
  }
  expect(macKeyRoute({ ...event('a'), metaKey: false })).toBe('native');
});
test('all native browser and edit commands map to engine shortcuts', () => {
  const letters: Record<string, string> = { 'new-tab':'t','close-tab':'w','focus-address':'l',reload:'r','edit-undo':'z','edit-redo':'z','edit-cut':'x','edit-copy':'c','edit-paste':'v','edit-select-all':'a' };
  for (const [command, key] of Object.entries(letters)) {
    const shortcut = commandShortcut(command)!;
    expect(shortcut.key).toBe(key); expect(shortcut.ctrl).toBe(true);
    expect(shortcutSequence(shortcut).filter(k => k[1] === `Key${key.toUpperCase()}`)).toEqual([[key.charCodeAt(0),`Key${key.toUpperCase()}`,true],[key.charCodeAt(0),`Key${key.toUpperCase()}`,false]]);
  }
  expect(commandShortcut('edit-redo')?.shift).toBe(true);
  expect(commandShortcut('stop')).toEqual({ key:'Escape', code:'Escape' });
  expect(commandShortcut('back')).toEqual({ key:'ArrowLeft', code:'ArrowLeft', alt:true });
  expect(commandShortcut('forward')).toEqual({ key:'ArrowRight', code:'ArrowRight', alt:true });
  expect(commandShortcut('next-tab')).toEqual({ key:'Tab', code:'Tab', ctrl:true });
  expect(commandShortcut('prev-tab')).toEqual({ key:'Tab', code:'Tab', ctrl:true, shift:true });
  for (let n = 1; n <= 9; n++) expect(commandShortcut(`select-tab:${n}`)).toEqual({ key:String(n), code:`Digit${n}`, ctrl:true });
  for (const command of ['take-control','release-control','mode-watch','mode-agent','mode-manual','open-desktop-view','show-audit','logout','select-tab:0']) expect(commandShortcut(command)).toBeUndefined();
});
test('viewOnly follows acknowledged ownership and fails closed on disconnect or takeover', () => {
  expect(viewOnly({ controller:'agent', yours:false }, true)).toBe(true);
  expect(viewOnly({ controller:'human', yours:true }, true)).toBe(false);
  expect(viewOnly({ controller:'human', yours:false }, true)).toBe(true);
  expect(viewOnly({ controller:'human', yours:true }, false)).toBe(true);
  expect(viewOnly({ controller:'agent', yours:true }, true)).toBe(true);
});
