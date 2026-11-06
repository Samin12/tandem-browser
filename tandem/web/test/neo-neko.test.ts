import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// neko's overlay maps every pointer position from its cursor canvas's bounding box.
// Hiding that canvas with display:none makes the box 0x0 and pins all input to the
// bottom-right corner, so it may only be hidden in a way that keeps its layout.
test('the painted-pointer canvas keeps its layout box', () => {
  const source = readFileSync(resolve(import.meta.dir, '../src/neo-neko.ts'), 'utf8');
  expect(source).not.toMatch(/canvas\.style\.display\s*=\s*['"]none['"]/);
  expect(source).toMatch(/canvas\.style\.visibility\s*=\s*['"]hidden['"]/);
});
