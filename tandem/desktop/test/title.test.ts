import { expect, test } from 'bun:test';
import { windowTitle } from '../src/title';
test('window titles normalize new and older gateway titles without repeated suffixes', () => {
  for (const title of ['Example', 'Example — Tandem', 'Example — Tandem Browser']) expect(windowTitle(title)).toBe('Example — Tandem');
  for (const title of ['', '  ', 'Tandem', 'Tandem Browser', 'BrowserOS neo', 'BrowserOS neo — Tandem Browser', 'browseros']) expect(windowTitle(title)).toBe('Tandem');
});
