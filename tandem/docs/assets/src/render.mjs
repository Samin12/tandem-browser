#!/usr/bin/env node
/** Render the checked-in SVG sources at 2×. No network or visible browser. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '../../../desktop/package.json'));
let Resvg;
try { ({ Resvg } = require('@resvg/resvg-js')); }
catch { throw new Error('Install the existing desktop dependencies first: cd tandem/desktop && bun install --frozen-lockfile'); }
const fontOptions = { loadSystemFonts: true, defaultFontFamily: 'Arial' };
// Inline local image references so output never depends on a working directory or network.
async function inlineImages(svg, dir) {
  const refs = [...svg.matchAll(/href="([^"#]+)"/g)];
  for (const [attribute, href] of refs) {
    if (/^(data:|https?:)/.test(href)) continue;
    const path = resolve(dir, href);
    const mime = path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.png') ? 'image/png' : 'image/jpeg';
    let data = await readFile(path);
    if (mime === 'image/svg+xml') data = Buffer.from(await inlineImages(data.toString(), dirname(path)));
    svg = svg.replace(attribute, `href="data:${mime};base64,${data.toString('base64')}"`);
  }
  return svg;
}
for (const name of ['hero', 'benefits', 'connects']) {
  const svg = await inlineImages(await readFile(resolve(here, `${name}.svg`), 'utf8'), here);
  const render = new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 }, font: fontOptions }).render();
  const output = resolve(here, '..', `${name}.png`);
  await writeFile(output, render.asPng());
  console.log(`${name}.png: ${render.width} × ${render.height}`);
}
const icon = await readFile(resolve(here, '../../../branding/app-icon.svg'));
await writeFile(resolve(here, '../icon.png'), new Resvg(icon, { fitTo: { mode: 'width', value: 256 } }).render().asPng());
console.log('icon.png: 256 × 256');
