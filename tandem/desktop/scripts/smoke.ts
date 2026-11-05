import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const brand = JSON.parse(await readFile(path.join(root, '../branding/brand.json'), 'utf8'));
const defaultBinary = path.join(root, `release/mac${process.arch === 'arm64' ? '-arm64' : ''}/${brand.productName}.app/Contents/MacOS/${brand.productName}`);
const binary = process.argv[2] ?? defaultBinary;
if (!await Bun.file(binary).exists()) throw new Error(`Packaged binary missing: ${binary}. Run bun run dist:mac first.`);
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === '/api/health') return Response.json({ ok: true, cdp: true, mcp: true, version: 'smoke' });
    return new Response(`<!doctype html><title>loading</title><script>
      const api = window.tandemDesktop;
      if (api && api.isDesktop) {
        let removedCallbackRan = false;
        const unsubscribe = api.onCommand(() => { removedCallbackRan = true; });
        unsubscribe();
        api.onCommand(command => { document.title = removedCallbackRan ? 'unsubscribe-failed' : 'smoke:command:' + command; });
        document.title = 'smoke:ready';
      } else document.title = 'smoke:bridge-missing';
    </script>`, { headers: { 'Content-Type': 'text/html' } });
  }
});
const foreign = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<title>foreign origin</title>', { headers: { 'Content-Type': 'text/html' } }) });
const env = { ...process.env, TANDEM_SMOKE: '1', TANDEM_SMOKE_URL: `http://127.0.0.1:${server.port}`, TANDEM_SMOKE_FOREIGN_URL: `http://127.0.0.1:${foreign.port}`, TANDEM_SMOKE_DATA_DIR: path.join(root, `release/.smoke-userdata-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
let child: ReturnType<typeof Bun.spawn> | undefined;
const timeout = setTimeout(() => { child?.kill(); console.error('Packaged smoke timed out.'); }, 45000);
try {
  child = Bun.spawn([binary], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  await mkdir(path.join(root, 'release'), { recursive: true });
  await Bun.write(path.join(root, 'release/smoke-result.json'), stdout);
  const result = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.smoke);
  if (code !== 0 || !result?.ok) process.exitCode = 1;
} finally { clearTimeout(timeout); server.stop(true); foreign.stop(true); }
