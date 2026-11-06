import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function generateIcons() {
  const root = resolve(import.meta.dir, '..');
  const svg = await readFile(resolve(root, '../branding/app-icon.svg'));
  await mkdir(resolve(root, 'build/icons'), { recursive: true });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
    await writeFile(resolve(root, `build/icons/${size}x${size}.png`), png);
    if (size === 1024) await writeFile(resolve(root, 'build/icon.png'), png);
  }
  console.log('Rendered app-icon.svg → build/icon.png (1024 px) and build/icons/ (16–1024 px)');
}
if (import.meta.main) await generateIcons();
