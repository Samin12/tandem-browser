import { describe, expect, test } from 'bun:test';
import { ClickCounter, keyMessage, modifiers, mouseButton, virtualKey, wheelDelta } from '../src/input';
const key = (overrides = {}) => ({ key: 'a', code: 'KeyA', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides });
describe('keyboard translation', () => {
  test('Mac Command becomes Linux Control, including its physical key', () => {
    expect(keyMessage(key({ metaKey: true }), 'down', true)).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 });
    expect(keyMessage(key({ metaKey: true }), 'down', true)).not.toHaveProperty('text');
    expect(keyMessage(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'down', true)).toMatchObject({ key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers: 2 });
    expect(keyMessage(key({ key: 'Meta', code: 'MetaRight' }), 'up', true)).toMatchObject({ key: 'Control', code: 'ControlRight', keyCode: 17, modifiers: 0 });
  });
  test('non-Mac Meta stays Meta; all CDP modifier bits combine', () => {
    expect(modifiers(key({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), false)).toBe(15);
    expect(modifiers(key({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true }), true)).toBe(11);
    expect(keyMessage(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'down', false)).toMatchObject({ key: 'Meta', keyCode: 91, modifiers: 4 });
  });
  test('only unmodified printable keydown carries text; Shift preserves case', () => {
    expect(keyMessage(key(), 'down', false).text).toBe('a');
    expect(keyMessage(key({ key: 'A', shiftKey: true }), 'down', true).text).toBe('A');
    expect(keyMessage(key({ key: ' ', code: 'Space' }), 'down', false).text).toBe(' ');
    for (const change of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: 'Enter', code: 'Enter' }, { key: 'Dead', code: 'Quote' }]) expect(keyMessage(key(change), 'down', false)).not.toHaveProperty('text');
    expect(keyMessage(key(), 'up', false)).not.toHaveProperty('text');
  });
  test('repeat and keypad location survive translation', () => {
    expect(keyMessage(key({ key: '1', code: 'Numpad1', location: 3, repeat: true }), 'down', true)).toMatchObject({ keyCode: 97, location: 3, autoRepeat: true });
  });
  const table: [string, string, number][] = [
    ['Backspace','Backspace',8],['Tab','Tab',9],['Enter','Enter',13],['Shift','ShiftLeft',16],['Control','ControlRight',17],['Alt','AltLeft',18],['Pause','Pause',19],['CapsLock','CapsLock',20],['Escape','Escape',27],[' ','Space',32],['PageUp','PageUp',33],['PageDown','PageDown',34],['End','End',35],['Home','Home',36],['ArrowLeft','ArrowLeft',37],['ArrowUp','ArrowUp',38],['ArrowRight','ArrowRight',39],['ArrowDown','ArrowDown',40],['Insert','Insert',45],['Delete','Delete',46],['Meta','MetaLeft',91],['ContextMenu','ContextMenu',93],['*','NumpadMultiply',106],['+','NumpadAdd',107],[',','NumpadComma',108],['-','NumpadSubtract',109],['.','NumpadDecimal',110],['/','NumpadDivide',111],['Enter','NumpadEnter',13],[';','Semicolon',186],['=','Equal',187],[',','Comma',188],['-','Minus',189],['.','Period',190],['/','Slash',191],['`','Backquote',192],['[','BracketLeft',219],['\\','Backslash',220],[']','BracketRight',221],["'",'Quote',222],['?','Slash',191],[':','',186],['Unidentified','',0],
  ];
  for (let i=0;i<10;i++) { table.push([String(i),`Digit${i}`,48+i], [String(i),`Numpad${i}`,96+i]); }
  for (let i=0;i<26;i++) table.push([String.fromCharCode(97+i),`Key${String.fromCharCode(65+i)}`,65+i]);
  for (let i=1;i<=12;i++) table.push([`F${i}`,`F${i}`,111+i]);
  test.each(table)('%s / %s → %i', (value, code, expected) => expect(virtualKey(value, code)).toBe(expected));
});
describe('pointer semantics', () => {
  test('correct browser button names and wheel delta modes', () => {
    expect([0,1,2,-1].map(mouseButton)).toEqual(['left','middle','right','none']);
    expect(wheelDelta(3,0,800)).toBe(3); expect(wheelDelta(3,1,800)).toBe(48); expect(wheelDelta(-1,2,800)).toBe(-800);
  });
  test('click counts require ≤500 ms, ≤4 px and matching button', () => {
    const c = new ClickCounter();
    expect(c.next(100,10,10,0)).toBe(1); expect(c.next(600,14,10,0)).toBe(2); expect(c.next(800,14,10,0)).toBe(3);
    expect(c.next(900,14,10,0)).toBe(4); expect(c.next(1000,19,10,0)).toBe(1);
    expect(c.next(1600,19,10,0)).toBe(1); expect(c.next(1650,19,10,2)).toBe(1);
  });
});
