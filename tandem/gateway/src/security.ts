import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(36).toString('base64url');
export function constantEqual(a: string, b: string) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function decodeBase32(value: string): Buffer {
  const s = value.toUpperCase().replace(/=+$/, '');
  if (!/^[A-Z2-7]+$/.test(s)) throw new Error('Invalid base32');
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const char of s) {
    acc = (acc << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 255); }
  }
  if (bits && (acc & ((1 << bits) - 1))) throw new Error('Invalid base32 padding');
  return Buffer.from(bytes);
}
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0, acc = 0, out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc >>> bits) & 31]; }
  }
  if (bits) out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(acc << (5 - bits)) & 31];
  return out;
}
export function totp(secret: string, time = Date.now()): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const h = createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: unknown, now = Date.now()) {
  const candidate = typeof code === 'string' && /^\d{6}$/.test(code) ? code : 'invalid';
  let valid = 0;
  for (const delta of [-30000, 0, 30000]) valid |= Number(constantEqual(totp(secret, now + delta), candidate));
  return valid === 1;
}
export class RateLimit {
  private failures = new Map<string, number[]>();
  constructor(readonly windowMs = 15 * 60000, readonly max = 5) {}
  retryAfter(ip: string, now = Date.now()): number {
    const times = (this.failures.get(ip) ?? []).filter(t => t > now - this.windowMs);
    if (times.length) this.failures.set(ip, times); else this.failures.delete(ip);
    return times.length >= this.max ? Math.max(1, Math.ceil((times[0]! + this.windowMs - now) / 1000)) : 0;
  }
  fail(ip: string, now = Date.now()) {
    this.retryAfter(ip, now);
    const times = this.failures.get(ip) ?? []; times.push(now); this.failures.set(ip, times);
  }
  clear(ip: string) { this.failures.delete(ip); }
  sweep(now = Date.now()) { for (const ip of this.failures.keys()) this.retryAfter(ip, now); }
}
export function isPrivateProxy(ip: string): boolean {
  ip = ip.replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return isIP(ip) === 6 && (ip === '::1' || /^(fc|fd)/i.test(ip));
}
export function clientIp(req: Request, peer: string): string {
  if (!isPrivateProxy(peer)) return peer;
  const chain = (req.headers.get('x-forwarded-for') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!chain.length || chain.some(ip => !isIP(ip))) return peer;
  // Walk inward from the trusted peer; do not trust attacker-prepended entries.
  let candidate = peer;
  for (let i = chain.length - 1; i >= 0 && isPrivateProxy(candidate); i--) candidate = chain[i]!;
  return candidate;
}
export function checkOrigin(req: Request, origins: string[], websocket = false): boolean {
  if (websocket || req.method !== 'GET') {
    if (!origins.includes(req.headers.get('origin') ?? '')) return false;
    if (!websocket && /(?:application\/json|\+json)(?:;|$)/i.test(req.headers.get('content-type') ?? '') && req.headers.get('x-tandem') !== '1') return false;
  }
  return true;
}
export const CSP = "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
export function securityHeaders(path: string) {
  const headers = new Headers({
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY', 'content-security-policy': path.startsWith('/desktop/')
      ? "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'; frame-ancestors 'none'" : CSP,
  });
  if (path.startsWith('/api/')) headers.set('cache-control', 'no-store');
  return headers;
}
export function navigationUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 10000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid URL');
  if (value === 'about:blank' || /^chrome:\/\/newtab\/?$/.test(value)) return value;
  if (/^(?:localhost|(?:[\p{L}\d-]+\.)+[\p{L}\d-]+)(?::\d+)?(?:[/?#]|$)/u.test(value) && !/\s/.test(value)) return new URL(`https://${value}`).href;
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL scheme refused');
    return url.href;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}
