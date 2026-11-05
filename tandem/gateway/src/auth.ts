import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config';
import { randomToken, sha256 } from './security';

export interface Session { id: string; createdAt: number; lastSeen: number; expiresAt: number }
export class Sessions {
  private db: Database;
  onRevoke: (id: string) => void = () => {};
  constructor(private config: Pick<Config, 'dataDir' | 'idleMs' | 'maxMs'>) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const path = join(config.dataDir, 'sessions.sqlite');
    this.db = new Database(path, { create: true }); chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)');
  }
  create(now = Date.now()) {
    const token = randomToken(), id = crypto.randomUUID();
    this.db.query('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(sha256(token), id, now, now);
    return { token, session: { id, createdAt: now, lastSeen: now, expiresAt: Math.min(now + this.config.idleMs, now + this.config.maxMs) } };
  }
  private row(where: string, key: string, touch: boolean, now: number): Session | null {
    const row = this.db.query(`SELECT * FROM sessions WHERE ${where} = ?`).get(key) as { hash: string; id: string; created: number; seen: number } | null;
    if (!row) return null;
    if (now >= row.created + this.config.maxMs || now >= row.seen + this.config.idleMs) { this.revoke(row.id); return null; }
    if (touch) this.db.query('UPDATE sessions SET seen = ? WHERE id = ?').run(now, row.id);
    const lastSeen = touch ? now : row.seen;
    return { id: row.id, createdAt: row.created, lastSeen, expiresAt: Math.min(row.created + this.config.maxMs, lastSeen + this.config.idleMs) };
  }
  fromRequest(req: Request, now = Date.now()) {
    const token = /(?:^|;\s*)tandem_session=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
    return token ? this.row('hash', sha256(token), true, now) : null;
  }
  byId(id: string, touch = false, now = Date.now()) { return this.row('id', id, touch, now); }
  revoke(id: string) { this.db.query('DELETE FROM sessions WHERE id = ?').run(id); this.onRevoke(id); }
  sweep(now = Date.now()) {
    const rows = this.db.query('SELECT id FROM sessions WHERE created <= ? OR seen <= ?').all(now - this.config.maxMs, now - this.config.idleMs) as { id: string }[];
    for (const row of rows) this.revoke(row.id);
  }
  close() { this.db.close(); }
}
export function sessionCookie(token: string, config: Pick<Config, 'production' | 'origins' | 'maxMs'>, origin: string, clear = false) {
  const secure = config.production || !config.origins.includes(origin) || new URL(origin).protocol !== 'http:';
  return `tandem_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(config.maxMs / 1000)}${secure ? '; Secure' : ''}`;
}
