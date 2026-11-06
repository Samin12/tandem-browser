#!/usr/bin/env node
/** Render GitHub's Markdown response locally, then screenshot it without opening windows. */
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../..');
const readmePath = resolve(repo, '.github/README.md');
const output = resolve(process.argv[2] ?? '/tmp/tandem-readme');
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await mkdir(output, { recursive: true });
const markdown = await readFile(readmePath, 'utf8');
const images = [...markdown.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1].replaceAll('&amp;', '&'));
for (const src of images.filter(src => !/^https?:/.test(src))) await access(resolve(dirname(readmePath), src));
console.log(`Verified ${images.filter(src => !/^https?:/.test(src)).length} local README image paths.`);
let html = execFileSync('gh', ['api', '-X', 'POST', 'markdown', '-f', 'mode=gfm', '-f', 'context=Samin12/tandem-browser', '-F', 'text=@.github/README.md'], { cwd: repo, encoding: 'utf8' });
await writeFile(join(output, 'github.html'), html);
// Inline the exact local assets and badges, so local file permissions and network timing
// cannot create a falsely broken screenshot. External badges must return real image data.
for (const match of [...html.matchAll(/<img\b[^>]*>/g)]) {
  const tag = match[0];
  const src = tag.match(/\bsrc="([^"]+)"/)[1];
  const original = (tag.match(/data-canonical-src="([^"]+)"/)?.[1] ?? src).replaceAll('&amp;', '&');
  let data, mime;
  if (/^https?:/.test(original)) {
    const response = await fetch(original);
    if (!response.ok) throw new Error(`Badge failed (${response.status}): ${original}`);
    mime = response.headers.get('content-type')?.split(';')[0];
    if (!mime?.startsWith('image/')) throw new Error(`Not an image: ${original}`);
    data = Buffer.from(await response.arrayBuffer());
  } else {
    const local = resolve(dirname(readmePath), original);
    data = await readFile(local);
    mime = local.endsWith('.png') ? 'image/png' : local.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
  }
  html = html.replace(tag, tag.replace(`src="${src}"`, `src="data:${mime};base64,${data.toString('base64')}"`));
}
const css = `
*{box-sizing:border-box}html{background:var(--outer);color:var(--text);color-scheme:light}body{margin:0;padding:32px;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}
:root{--outer:#f6f8fa;--paper:#fff;--text:#1f2328;--muted:#59636e;--line:#d1d9e0;--link:#0969da;--code:#f6f8fa;--shade:#f6f8fa}
:root.dark{--outer:#010409;--paper:#0d1117;--text:#f0f6fc;--muted:#9198a1;--line:#3d444d;--link:#4493f8;--code:#151b23;--shade:#151b23;color-scheme:dark}
article{max-width:1012px;margin:auto;background:var(--paper);border:1px solid var(--line);border-radius:6px;padding:32px 40px;color:var(--text);overflow-wrap:break-word}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}p{margin:0 0 16px}p[align=center]{text-align:center}h1,h2{font-weight:600;line-height:1.25;border-bottom:1px solid var(--line);padding-bottom:.3em;margin:24px 0 16px}h1{font-size:32px}h2{font-size:24px}h1[align=center]{text-align:center}img{max-width:100%;vertical-align:middle}sub{font-size:12px;color:var(--muted)}table{border-spacing:0;border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin-bottom:16px}th,td{padding:6px 13px;border:1px solid var(--line)}th{font-weight:600}tr:nth-child(2n){background:var(--shade)}td img{display:block}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:85%}code{background:var(--code);padding:.2em .4em;border-radius:6px}pre{padding:16px;overflow:auto;background:var(--code);border-radius:6px;line-height:1.45;margin:0 0 16px}pre code{padding:0;font-size:100%;border:0}ul,ol{padding-left:2em;margin:0 0 16px}li+li{margin-top:.25em}.markdown-heading .anchor{display:none}markdown-accessiblity-table{display:block;max-width:100%;overflow:auto}
@media(max-width:650px){body{padding:0}article{padding:24px 16px;border:0;border-radius:0}h1{margin-top:16px}}
`;
const profile = await mkdtemp(join(tmpdir(), 'tandem-readme-chrome-'));
// Set the actual viewport with CDP: --window-size alone has a minimum width in
// newer Chrome and can silently crop a 390px screenshot of a 500px layout.
const browser = spawn(chrome, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let nextId = 0, buffer = '';
const pending = new Map();
browser.stdio[4].on('data', chunk => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!raw) continue;
    const result = JSON.parse(raw), callback = pending.get(result.id);
    if (callback) { pending.delete(result.id); clearTimeout(callback.timer); result.error ? callback.reject(new Error(JSON.stringify(result.error))) : callback.resolve(result.result); }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, sessionId);
  for (const [name, theme, width] of [['desktop-light','light',1280],['desktop-dark','dark',1280],['narrow-light','light',390],['narrow-dark','dark',390]]) {
    const doc = `<!doctype html><html class="${theme}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tandem README preview</title><style>${css}</style></head><body><article class="markdown-body">${html}</article></body></html>`;
    const htmlPath = join(output, `${name}.html`);
    await writeFile(htmlPath, doc);
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp('Page.navigate', { url: pathToFileURL(htmlPath).href }, sessionId);
    // Wait for the local document and all inlined images, without network activity.
    const ready = await cdp('Runtime.evaluate', { expression: `(async()=>{while(document.readyState!=='complete') await new Promise(r=>setTimeout(r,20));await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));return {width:innerWidth,height:Math.ceil(document.documentElement.scrollHeight),overflow:document.documentElement.scrollWidth>innerWidth,broken:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length}})()`, awaitPromise: true, returnByValue: true }, sessionId);
    const layout = ready.result.value;
    if (!layout || layout.width !== width || layout.broken || layout.overflow) throw new Error(`Invalid layout: ${name}, ${JSON.stringify(layout ?? ready)}`);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height: layout.height, scale: 1 } }, sessionId);
    await writeFile(join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
    console.log(`${name}.png: ${width} × ${layout.height}; verified viewport, no broken images or page overflow`);
  }
  const tags = [...html.matchAll(/<img\b[^>]*>/g)].map(match => match[0]);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const sheet = `<!doctype html><html><head><meta charset="UTF-8"><title>README image audit</title><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#F7FAFD;color:#14202B;font:15px/1.4 Arial,sans-serif}h1{margin:0 0 20px;font-size:26px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}figure{margin:0;border:1px solid #DCE6F0;border-radius:12px;background:white;padding:16px}figure div{height:340px;display:flex;align-items:center;justify-content:center;overflow:hidden}img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}figcaption{margin-top:12px;overflow-wrap:anywhere;font-size:13px;color:#5F6B78}</style></head><body><h1>Every README image · cloud blue audit</h1><main>${tags.map((tag, index) => `<figure><div>${tag.replace(/\s(?:width|height)="[^"]*"/g, '')}</div><figcaption>${escape(images[index] ?? `Image ${index + 1}`)}</figcaption></figure>`).join('')}</main></body></html>`;
  const sheetPath = join(output, 'contact-sheet.html');
  await writeFile(sheetPath, sheet);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp('Page.navigate', { url: pathToFileURL(sheetPath).href }, sessionId);
  const ready = await cdp('Runtime.evaluate', { expression: `(async()=>{while(document.readyState!=='complete')await new Promise(r=>setTimeout(r,20));await Promise.all([...document.images].map(i=>i.decode()));return {height:document.documentElement.scrollHeight,count:document.images.length}})()`, awaitPromise: true, returnByValue: true }, sessionId);
  if (ready.exceptionDetails || ready.result.value.count !== images.length) throw new Error('Incomplete image contact sheet');
  const contact = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1600, height: ready.result.value.height, scale: 1 } }, sessionId);
  await writeFile(join(output, 'contact-sheet.png'), Buffer.from(contact.data, 'base64'));
  console.log(`contact-sheet.png: ${images.length} README images`);
  await cdp('Target.closeTarget', { targetId });
} finally {
  await cdp('Browser.close').catch(() => {});
  await new Promise(resolve => { if (browser.exitCode !== null) resolve(); else browser.once('exit', resolve); });
  await rm(profile, { recursive: true, force: true });
}
