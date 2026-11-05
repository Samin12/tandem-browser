import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const brand = JSON.parse(await readFile('../branding/brand.json', 'utf8'));
await writeFile('dist/brand.json', JSON.stringify(brand, null, 2));
await cp('pages', 'dist/pages', { recursive: true });
await cp('../branding/logo.svg', 'dist/pages/logo.svg');
await cp('../../LICENSE', 'dist/LICENSE');
await writeFile('dist/pages/brand.js', `window.brand = ${JSON.stringify(brand).replaceAll('<', '\\u003c')};\n`);
