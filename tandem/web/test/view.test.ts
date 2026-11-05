import { expect, test } from 'bun:test';
import { persistView, selectView } from '../src/view';
function storage(value: string | null = null) { return { getItem: () => value, setItem: (key: string, next: string) => { expect(key).toBe('tandem.view'); value = next; } }; }
test('Neo is default and invalid preferences cannot select another view', () => {
  expect(selectView('', storage())).toBe('neo'); expect(selectView('?view=invalid', storage('invalid'))).toBe('neo');
});
test('URL selection wins and persists across later visits', () => {
  const saved = storage('neo'); expect(selectView('?view=lite', saved)).toBe('lite'); expect(selectView('', saved)).toBe('lite');
  expect(selectView('?view=neo', saved)).toBe('neo'); expect(selectView('', saved)).toBe('neo');
});
test('menu selection persists and invalid URL falls back to saved choice', () => {
  const saved = storage(); persistView('lite', saved); expect(selectView('', saved)).toBe('lite');
  expect(selectView('?view=unknown', saved)).toBe('lite');
});
test('disabled localStorage remains optional for reads and writes', () => {
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  expect(selectView('', blocked)).toBe('neo'); expect(selectView('?view=lite', blocked)).toBe('lite');
  expect(() => persistView('neo', blocked)).not.toThrow();
});
