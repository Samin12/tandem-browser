import { mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = import.meta.dir;
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(resolve(root, 'dist/assets'), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/app.ts'), resolve(root, 'src/login.ts')],
  outdir: resolve(root, 'dist/assets'), target: 'browser', minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Build failed');
await Promise.all([
  ...['index.html', 'login.html'].map(name => copyFile(resolve(root, name), resolve(root, 'dist', name))),
  copyFile(resolve(root, 'src/styles.css'), resolve(root, 'dist/assets/styles.css')),
  copyFile(resolve(root, '../branding/brand.json'), resolve(root, 'dist/brand.json')),
  copyFile(resolve(root, '../branding/logo.svg'), resolve(root, 'dist/favicon.svg')),
  copyFile(resolve(root, '../branding/logo.svg'), resolve(root, 'dist/logo.svg')),
]);
console.log('Built dist/');
