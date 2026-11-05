import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = Bun.spawn([require('electron'), '.', ...process.argv.slice(2)], { env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
