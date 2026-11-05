import type { Cdp } from './cdp';

const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number): v is number => finite(v, min, max) && Number.isInteger(v);
export function inputCommand(m: Record<string, any>): { method: string; params: Record<string, unknown> } {
  if (m.t === 'input.text') {
    if (typeof m.text !== 'string' || m.text.length > 100000) throw new Error('Invalid input text');
    return { method: 'Input.insertText', params: { text: m.text } };
  }
  if (m.t === 'input.mouse') {
    if (!['move', 'down', 'up', 'wheel'].includes(m.type) || !finite(m.x, 0, 100000) || !finite(m.y, 0, 100000)
      || (m.button !== undefined && !['none', 'left', 'middle', 'right'].includes(m.button))
      || (m.buttons !== undefined && !integer(m.buttons, 0, 31)) || (m.clickCount !== undefined && !integer(m.clickCount, 0, 10))
      || (m.modifiers !== undefined && !integer(m.modifiers, 0, 15))
      || (m.deltaX !== undefined && !finite(m.deltaX, -100000, 100000)) || (m.deltaY !== undefined && !finite(m.deltaY, -100000, 100000))) throw new Error('Invalid mouse input');
    return { method: 'Input.dispatchMouseEvent', params: {
      type: ({ move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' } as Record<string, string>)[m.type],
      x: m.x, y: m.y, button: m.button ?? 'none', buttons: m.buttons ?? 0, clickCount: m.clickCount ?? 0, modifiers: m.modifiers ?? 0,
      ...(m.type === 'wheel' ? { deltaX: m.deltaX ?? 0, deltaY: m.deltaY ?? 0 } : {}),
    } };
  }
  if (m.t === 'input.key') {
    if (!['down', 'up'].includes(m.type) || typeof m.key !== 'string' || m.key.length > 100 || typeof m.code !== 'string' || m.code.length > 100
      || !integer(m.keyCode, 0, 65535) || !integer(m.modifiers, 0, 15) || (m.location !== undefined && !integer(m.location, 0, 3))
      || (m.autoRepeat !== undefined && typeof m.autoRepeat !== 'boolean') || (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 100000))) throw new Error('Invalid key input');
    return { method: 'Input.dispatchKeyEvent', params: { type: m.type === 'up' ? 'keyUp' : m.text !== undefined ? 'keyDown' : 'rawKeyDown',
      key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: m.modifiers,
      location: m.location ?? 0, autoRepeat: m.autoRepeat ?? false,
      ...(m.text !== undefined ? { text: m.text, unmodifiedText: m.text } : {}) } };
  }
  throw new Error('Unknown input command');
}
export async function copySelection(cdp: Cdp, targetId: string): Promise<string> {
  const result = await cdp.page(targetId, 'Runtime.evaluate', { expression: `(() => { const e = document.activeElement; return ((e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) && typeof e.selectionStart === 'number' ? e.value.slice(e.selectionStart, e.selectionEnd) : String(getSelection() || '')).slice(0,100000); })()`, returnByValue: true });
  return typeof result.result?.value === 'string' ? result.result.value.slice(0, 100000) : '';
}
