import { resolve } from 'node:path';
import { decodeBase32 } from './security';

export interface Config {
  hostname: string; port: number; origins: string[]; production: boolean;
  passwordHash: string; totpSecret?: string; agentToken: string; dataDir: string;
  idleMs: number; maxMs: number; holdMs: number; displayScale: number; cdpUrl: string; agentCdp: boolean;
  mcpUrl: string; novncUrl: string; nekoUrl?: string; nekoUserPassword?: string; nekoApiToken?: string; publicDir: string; brandFile: string;
}

export async function loadConfig(env: Record<string, string | undefined> = process.env): Promise<Config> {
  const fail = (name: string, reason: string): never => { throw new Error(`${name}: ${reason}`); };
  const mode = env.TANDEM_ENV ?? 'production';
  if (!['production', 'development'].includes(mode)) fail('TANDEM_ENV', 'expected production or development');
  const production = mode === 'production';
  const origins = (env.TANDEM_PUBLIC_ORIGIN ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origins.length) fail('TANDEM_PUBLIC_ORIGIN', 'required');
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw 0;
    } catch { fail('TANDEM_PUBLIC_ORIGIN', 'expected exact http(s) origins without paths'); }
    if (production && !origin.startsWith('https:')) fail('TANDEM_PUBLIC_ORIGIN', 'production requires https origins');
  }
  if (production && env.TANDEM_PASSWORD !== undefined) fail('TANDEM_PASSWORD', 'development only; use TANDEM_PASSWORD_HASH');
  let passwordHash = env.TANDEM_PASSWORD_HASH;
  if (!passwordHash && env.TANDEM_PASSWORD) passwordHash = await Bun.password.hash(env.TANDEM_PASSWORD, { algorithm: 'argon2id' });
  if (!passwordHash?.startsWith('$argon2id$')) fail('TANDEM_PASSWORD_HASH', 'a valid Argon2id hash is required');
  try { await Bun.password.verify('configuration-validation', passwordHash!); } catch { fail('TANDEM_PASSWORD_HASH', 'invalid Argon2id hash'); }
  if (!env.TANDEM_AGENT_TOKEN || env.TANDEM_AGENT_TOKEN.length < 32) fail('TANDEM_AGENT_TOKEN', 'required, at least 32 characters');
  if (env.TANDEM_TOTP_SECRET) {
    try { if (decodeBase32(env.TANDEM_TOTP_SECRET).length === 0) throw 0; } catch { fail('TANDEM_TOTP_SECRET', 'expected a non-empty base32 secret'); }
  }
  const positive = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isFinite(n) || n <= 0) fail(key, 'expected a positive number');
    return n;
  };
  const endpoint = (key: string, fallback: string) => {
    const value = env[key] ?? fallback;
    try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw 0; }
    catch { fail(key, 'expected an http(s) URL without credentials'); }
    return value;
  };
  if (env.TANDEM_NEKO_URL) {
    for (const key of ['TANDEM_NEKO_USER_PASSWORD', 'TANDEM_NEKO_API_TOKEN']) if (!env[key]) fail(key, 'required when TANDEM_NEKO_URL is set');
    const url = new URL(endpoint('TANDEM_NEKO_URL', ''));
    if (url.pathname !== '/' || url.search) fail('TANDEM_NEKO_URL', 'expected an http(s) origin without a path or query');
  }
  if (!['on', 'off'].includes(env.TANDEM_CDP ?? 'on')) fail('TANDEM_CDP', 'expected on or off');
  const listen = /^(\[[\da-fA-F:]+\]|[^:]+):(\d+)$/.exec(env.TANDEM_LISTEN ?? '0.0.0.0:8790');
  if (!listen || Number(listen[2]) < 1 || Number(listen[2]) > 65535) fail('TANDEM_LISTEN', 'expected host:port (1–65535)');
  return {
    hostname: listen![1]!.replace(/^\[|\]$/g, ''), port: Number(listen![2]), origins, production,
    passwordHash: passwordHash!, agentToken: env.TANDEM_AGENT_TOKEN!, totpSecret: env.TANDEM_TOTP_SECRET,
    dataDir: resolve(env.TANDEM_DATA_DIR ?? '/var/lib/tandem'),
    idleMs: positive('TANDEM_SESSION_IDLE_HOURS', 12) * 3600000,
    maxMs: positive('TANDEM_SESSION_MAX_HOURS', 72) * 3600000,
    holdMs: positive('TANDEM_AGENT_HOLD_SECONDS', 120) * 1000,
    // Must match the engine's --force-device-scale-factor (compose passes both from one value).
    displayScale: Math.min(3, positive('TANDEM_DISPLAY_SCALE', 1)),
    agentCdp: env.TANDEM_CDP !== 'off',
    cdpUrl: endpoint('TANDEM_CDP_URL', 'http://127.0.0.1:9110'),
    mcpUrl: endpoint('TANDEM_NEO_MCP_URL', 'http://127.0.0.1:9010/mcp'),
    nekoUrl: env.TANDEM_NEKO_URL || undefined, nekoUserPassword: env.TANDEM_NEKO_USER_PASSWORD, nekoApiToken: env.TANDEM_NEKO_API_TOKEN,
    novncUrl: endpoint('TANDEM_NOVNC_URL', 'http://127.0.0.1:6080'),
    publicDir: resolve(env.TANDEM_PUBLIC_DIR ?? './public'), brandFile: resolve(env.TANDEM_BRAND_FILE ?? './brand.json'),
  };
}
