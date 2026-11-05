import type { Control } from './types';
import type { KeyLike } from './input';
export type KeyStroke = [keysym: number, code: string, down: boolean];
export interface Shortcut { key: string; code: string; ctrl?: boolean; shift?: boolean; alt?: boolean }
const special: Record<string, number> = {
  Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53,
  ArrowDown: 0xff54, PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63,
};
export function keysym(key: string): number | undefined {
  if (special[key]) return special[key];
  if (/^F([1-9]|1[0-2])$/.test(key)) return 0xffbd + Number(key.slice(1));
  const lower = /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
  return lower.length === 1 && lower.charCodeAt(0) <= 255 ? lower.charCodeAt(0) : undefined;
}
export function shortcutSequence(shortcut: Shortcut): KeyStroke[] {
  const sym = keysym(shortcut.key);
  if (sym === undefined) return [];
  const modifiers: [number, string][] = [];
  if (shortcut.ctrl) modifiers.push([0xffe3, 'ControlLeft']);
  if (shortcut.shift) modifiers.push([0xffe1, 'ShiftLeft']);
  if (shortcut.alt) modifiers.push([0xffe9, 'AltLeft']);
  return [...modifiers.map(([key, code]): KeyStroke => [key, code, true]),
    [sym, shortcut.code, true], [sym, shortcut.code, false],
    ...modifiers.reverse().map(([key, code]): KeyStroke => [key, code, false])];
}
function shortcutKey(event: KeyLike): string {
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : event.key;
}
export function macKeyRoute(event: KeyLike): 'local' | 'paste' | 'remap' | 'native' {
  if (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight') return 'local';
  if (!event.metaKey) return 'native';
  if (['q', 'h', 'm', '`'].includes(shortcutKey(event).toLowerCase()) || event.code === 'Backquote') return 'local';
  return shortcutKey(event).toLowerCase() === 'v' && !event.altKey ? 'paste' : 'remap';
}
export function macKeySequence(event: KeyLike): KeyStroke[] {
  return macKeyRoute(event) === 'remap' ? shortcutSequence({ key: shortcutKey(event), code: event.code, ctrl: true, shift: event.shiftKey, alt: event.altKey }) : [];
}
export function commandShortcut(command: string): Shortcut | undefined {
  const letters: Record<string, string> = {
    'new-tab': 't', 'close-tab': 'w', 'focus-address': 'l', reload: 'r',
    'edit-undo': 'z', 'edit-redo': 'z', 'edit-cut': 'x', 'edit-copy': 'c', 'edit-select-all': 'a', 'edit-paste': 'v',
  };
  if (letters[command]) return { key: letters[command], code: `Key${letters[command].toUpperCase()}`, ctrl: true, ...(command === 'edit-redo' ? { shift: true } : {}) };
  if (command === 'stop') return { key: 'Escape', code: 'Escape' };
  if (command === 'back' || command === 'forward') return { key: command === 'back' ? 'ArrowLeft' : 'ArrowRight', code: command === 'back' ? 'ArrowLeft' : 'ArrowRight', alt: true };
  if (command === 'next-tab' || command === 'prev-tab') return { key: 'Tab', code: 'Tab', ctrl: true, ...(command === 'prev-tab' ? { shift: true } : {}) };
  const match = /^select-tab:([1-9])$/.exec(command);
  if (match) return { key: match[1], code: `Digit${match[1]}`, ctrl: true };
}
export function viewOnly(control: Pick<Control, 'controller' | 'yours'>, connected: boolean): boolean {
  return !connected || control.controller !== 'human' || !control.yours;
}
