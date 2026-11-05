export interface KeyLike {
  key: string; code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean;
  location?: number; repeat?: boolean;
}
const keys: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19,
  CapsLock: 20, Escape: 27, ' ': 32, Space: 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93, NumLock: 144, ScrollLock: 145,
  Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191,
  Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
  NumpadMultiply: 106, NumpadAdd: 107, NumpadComma: 108, NumpadSubtract: 109,
  NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13, NumpadEqual: 187,
};
const punctuation: Record<string, number> = { ';': 186, ':': 186, '=': 187, '+': 187, ',': 188, '<': 188, '-': 189, '_': 189, '.': 190, '>': 190, '/': 191, '?': 191, '`': 192, '~': 192, '[': 219, '{': 219, '\\': 220, '|': 220, ']': 221, '}': 221, "'": 222, '"': 222 };
export function virtualKey(key: string, code: string): number {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(-1));
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
  if (keys[code] !== undefined) return keys[code];
  if (keys[key] !== undefined) return keys[key];
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return punctuation[key] ?? 0;
}
export function modifiers(event: Pick<KeyLike, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, mac: boolean): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey || (mac && event.metaKey) ? 2 : 0) |
    (!mac && event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}
export function keyMessage(event: KeyLike, type: 'down' | 'up', mac: boolean) {
  const isMacMeta = mac && (event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight');
  const key = isMacMeta ? 'Control' : event.key;
  const code = isMacMeta ? (event.code === 'MetaRight' ? 'ControlRight' : 'ControlLeft') : event.code;
  return { t: 'input.key', type, key, code, keyCode: isMacMeta ? 17 : virtualKey(key, code),
    ...(type === 'down' && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey ? { text: event.key } : {}),
    modifiers: modifiers(event, mac), location: event.location ?? 0, autoRepeat: event.repeat ?? false };
}
export function mouseButton(button: number): 'left' | 'middle' | 'right' | 'none' {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : 'none';
}
export function wheelDelta(delta: number, mode: number, pageSize: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? pageSize : 1);
}
export class ClickCounter {
  private previous?: { at: number; x: number; y: number; button: number; count: number };
  next(at: number, x: number, y: number, button: number): number {
    const p = this.previous;
    const count = p && at - p.at <= 500 && Math.hypot(x - p.x, y - p.y) <= 4 && p.button === button ? p.count + 1 : 1;
    this.previous = { at, x, y, button, count };
    return count;
  }
}
