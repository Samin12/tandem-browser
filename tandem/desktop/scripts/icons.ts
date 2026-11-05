import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('build', { recursive: true });
const svg = await readFile('../branding/logo.svg');
const icon = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng();
await writeFile('build/icon.png', icon);
console.log(`build/icon.png: 1024 × 1024 (${icon.length} bytes)`);
