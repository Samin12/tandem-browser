import { closeSync, chmodSync, openSync, fstatSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';

type Actor = 'human' | 'agent' | 'system';
export interface AuditEntry { ts: string; actor: Actor; sessionId?: string; ip?: string; event: string; detail: Record<string, unknown> }
const allowed: Record<string, string[]> = {
  'login.ok': [], 'login.fail': [], logout: [],
  'control.take': [], 'control.release': [], 'control.auto_release': [],
  'tab.new': ['targetId', 'origin'], 'tab.close': ['targetId'], 'tab.activate': ['targetId'], 'nav.go': ['targetId', 'origin'],
  'agent.tool': ['name', 'heldMs', 'outcome'], 'agent.denied': ['name', 'heldMs', 'outcome'], 'desktop.open': [],
};
export function urlOrigin(value: string) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin : u.protocol; } catch { return 'unknown'; } }
export class Audit {
  private fd: number;
  private closed = false;
  readonly path: string;
  constructor(dir: string) { this.path = join(dir, 'audit.log'); this.fd = openSync(this.path, 'a', 0o600); chmodSync(this.path, 0o600); }
  write(actor: Actor, event: string, detail: Record<string, unknown> = {}, context: { sessionId?: string; ip?: string } = {}) {
    if (this.closed || !allowed[event]) return;
    const safe: Record<string, unknown> = {};
    for (const key of allowed[event]) {
      const value = detail[key];
      if (key === 'origin' && typeof value === 'string') safe[key] = urlOrigin(value);
      else if ((key === 'name' || key === 'targetId') && typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value)) safe[key] = value;
      else if (key === 'heldMs' && typeof value === 'number') safe[key] = Math.max(0, Math.round(value));
      else if (key === 'outcome' && ['ok', 'error', 'timeout', 'cancelled'].includes(String(value))) safe[key] = value;
    }
    const entry: AuditEntry = { ts: new Date().toISOString(), actor, ...context, event, detail: safe };
    writeSync(this.fd, `${JSON.stringify(entry)}\n`);
  }
  tail(limit: number) {
    limit = Number.isFinite(limit) ? Math.min(1000, Math.max(1, Math.floor(limit))) : 200;
    const fd = openSync(this.path, 'r');
    try {
      let position = fstatSync(fd).size, lines = 0;
      const chunks: Buffer[] = [];
      while (position > 0 && lines <= limit) {
        const size = Math.min(position, 8192), chunk = Buffer.alloc(size); position -= size;
        readSync(fd, chunk, 0, size, position); chunks.unshift(chunk);
        for (const byte of chunk) if (byte === 10) lines++;
      }
      return Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).slice(-limit).map(line => JSON.parse(line) as AuditEntry);
    } finally { closeSync(fd); }
  }
  close() { if (!this.closed) { this.closed = true; closeSync(this.fd); } }
}
export function log(event: string, fields: Record<string, string | number | boolean> = {}) { console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields })); }
