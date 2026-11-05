import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Audit } from './audit';

export class Control {
  controller: 'agent' | 'human' = 'agent';
  holderSessionId?: string;
  since = Date.now();
  pendingAgentCalls = 0;
  activeAgentCalls = 0;
  lastAgentTool?: { name: string; at: number };
  onChange: () => void = () => {};
  private connections = new Map<string, number>();
  private waiters = new Set<() => void>();
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private path: string;
  constructor(dir: string, private audit: Audit, private disconnectMs = 60000) {
    this.path = join(dir, 'state.json');
    try {
      const state = JSON.parse(readFileSync(this.path, 'utf8'));
      if (state.controller === 'human' && typeof state.holderSessionId === 'string') {
        this.controller = 'human'; this.holderSessionId = state.holderSessionId;
        this.since = Number(state.since) || Date.now(); this.scheduleRelease();
      }
    } catch {}
    this.persist();
  }
  private persist() {
    writeFileSync(`${this.path}.tmp`, JSON.stringify({ controller: this.controller, holderSessionId: this.holderSessionId, since: this.since }), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
  state(id: string) {
    return { controller: this.controller, holderSessionId: this.holderSessionId, holderLabel: this.controller === 'human' ? 'Owner' : undefined,
      since: this.since, yours: this.holds(id), agentBusy: this.activeAgentCalls > 0, pendingAgentCalls: this.pendingAgentCalls, lastAgentTool: this.lastAgentTool };
  }
  holds(id: string) { return this.controller === 'human' && this.holderSessionId === id; }
  take(id: string) {
    clearTimeout(this.releaseTimer); this.controller = 'human'; this.holderSessionId = id; this.since = Date.now();
    this.persist(); this.audit.write('human', 'control.take', {}, { sessionId: id }); this.onChange();
    if (!this.connections.get(id)) this.scheduleRelease();
  }
  release(id?: string, automatic = false) {
    if (this.controller !== 'human' || (id && !this.holds(id))) return false;
    const holder = this.holderSessionId;
    clearTimeout(this.releaseTimer); this.controller = 'agent'; this.holderSessionId = undefined; this.since = Date.now(); this.persist();
    this.audit.write(automatic ? 'system' : 'human', automatic ? 'control.auto_release' : 'control.release', {}, { sessionId: holder });
    for (const resolve of this.waiters) resolve();
    this.onChange(); return true;
  }
  connected(id: string) { this.connections.set(id, (this.connections.get(id) ?? 0) + 1); if (this.holds(id)) clearTimeout(this.releaseTimer); }
  disconnected(id: string) {
    const n = Math.max(0, (this.connections.get(id) ?? 0) - 1);
    if (n) this.connections.set(id, n); else this.connections.delete(id);
    if (!n && this.holds(id)) this.scheduleRelease();
  }
  private scheduleRelease() { clearTimeout(this.releaseTimer); this.releaseTimer = setTimeout(() => this.release(undefined, true), this.disconnectMs); }
  async waitForAgent(ms: number, signal?: AbortSignal): Promise<'ready' | 'timeout' | 'cancelled'> {
    if (signal?.aborted) return 'cancelled';
    if (this.controller === 'agent') return 'ready';
    this.pendingAgentCalls++; this.onChange();
    try {
      return await new Promise(resolve => {
        const finish = (result: 'ready' | 'timeout' | 'cancelled') => { clearTimeout(timer); this.waiters.delete(ready); signal?.removeEventListener('abort', abort); resolve(result); };
        const ready = () => finish('ready'), abort = () => finish('cancelled');
        const timer = setTimeout(() => finish('timeout'), ms);
        this.waiters.add(ready); signal?.addEventListener('abort', abort, { once: true });
      });
    } finally { this.pendingAgentCalls--; this.onChange(); }
  }
  started(name: string) { this.activeAgentCalls++; this.lastAgentTool = { name, at: Date.now() }; this.onChange(); }
  finished() { this.activeAgentCalls = Math.max(0, this.activeAgentCalls - 1); this.onChange(); }
  close() { clearTimeout(this.releaseTimer); }
}
