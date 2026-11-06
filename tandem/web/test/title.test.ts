import { expect, test } from 'bun:test';
import { pageTitle } from '../src/title';
test('viewer titles use Tandem and hide an empty or engine landing page title', () => {
  expect(pageTitle('Example page')).toBe('Example page — Tandem');
  for (const title of ['', '  ', 'BrowserOS neo', 'browseros — New tab']) expect(pageTitle(title)).toBe('Tandem');
});
