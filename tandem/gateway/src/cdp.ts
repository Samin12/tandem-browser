import { EventEmitter } from 'node:events';
import { navigationUrl } from './security';
import { log } from './audit';

export interface Tab {
  targetId: string; url: string; title: string; loading: boolean;
  canGoBack: boolean; canGoForward: boolean; opener: 'agent' | 'human' | 'unknown'; lastAgentActivityAt?: number;
}
class CdpError extends Error {
  constructor(readonly code: number, readonly inactivePage: boolean) { super('Browser command failed'); }
}
export class Cdp extends EventEmitter {
  connected = false;
  tabs = new Map<string, Tab>();
  activeTargetId?: string;
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<number, { method: string; resolve: (r: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sessions = new Map<string, Promise<string>>();
  private targetsBySession = new Map<string, string>();
  private backoff = 250;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private humanCreates = 0;
  private discoverReady = false;
  private provenance = new Map<string, Tab['opener']>();
  constructor(private url: string, private agentControls: () => boolean) { super(); }
  start() { void this.connect(); }
  async connect() {
    if (this.stopped) return;
    try {
      const response = await fetch(`${this.url.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(5000) });
      const version = await response.json() as { webSocketDebuggerUrl: string };
      if (this.stopped) return;
      const ws = new WebSocket(version.webSocketDebuggerUrl); this.ws = ws;
      ws.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(message.id);
            if (message.error) { if (message.error.message !== 'Not attached to an active page') log('cdp.command_failed', { code: message.error.code, method: pending.method }); pending.reject(new CdpError(message.error.code, message.error.message === 'Not attached to an active page')); } else pending.resolve(message.result ?? {});
          } else this.event(message.method, message.params ?? {}, message.sessionId);
        } catch { log('cdp.invalid_message'); }
      };
      ws.onerror = () => {};
      ws.onclose = () => this.lost();
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.addEventListener('error', () => reject(new Error('CDP unavailable')), { once: true });
        ws.addEventListener('close', () => reject(new Error('CDP closed')), { once: true });
      });
      if (this.stopped) { ws.close(); return; }
      this.connected = true;
      await this.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await this.send('Target.getTargets');
      for (const info of targetInfos) this.upsert(info, false);
      this.discoverReady = true;
      for (const id of this.provenance.keys()) if (!this.tabs.has(id)) this.provenance.delete(id);
      this.backoff = 250; this.emit('tabs'); this.emit('connected'); log('cdp.connected');
    } catch {
      this.ws?.close(); this.lost();
    }
  }
  private lost() {
    this.connected = false; this.discoverReady = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser disconnected')); }
    this.pending.clear(); this.sessions.clear(); this.targetsBySession.clear(); this.tabs.clear(); this.activeTargetId = undefined;
    this.emit('disconnected'); this.emit('tabs');
    if (!this.stopped && !this.retry) {
      this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, this.backoff);
      this.backoff = Math.min(15000, this.backoff * 2);
    }
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Browser unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); log('cdp.command_timeout', { method }); reject(new Error('Browser command timed out')); }, 15000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  private upsert(info: any, activity: boolean) {
    if (info.type !== 'page') return;
    const old = this.tabs.get(info.targetId);
    const tab: Tab = { targetId: info.targetId, url: info.url, title: info.title,
      loading: old?.loading ?? false, canGoBack: old?.canGoBack ?? false, canGoForward: old?.canGoForward ?? false,
      opener: old?.opener ?? this.provenance.get(info.targetId) ?? (activity && this.humanCreates ? 'human' : activity && this.agentControls() ? 'agent' : 'unknown'),
      lastAgentActivityAt: old?.lastAgentActivityAt };
    this.tabs.set(info.targetId, tab); this.provenance.set(info.targetId, tab.opener);
    this.activeTargetId ??= info.targetId;
    if (activity && !this.humanCreates && this.agentControls() && (!old || old.url !== tab.url)) this.activity(info.targetId);
    this.emit('tabs');
  }
  activity(targetId: string, tool?: string) {
    if (!this.agentControls()) return;
    const tab = this.tabs.get(targetId); if (!tab) return;
    tab.lastAgentActivityAt = Date.now();
    this.emit('activity', { t: 'agent.activity', tool: tool ?? 'browser', targetId, at: tab.lastAgentActivityAt });
    this.emit('tabs');
  }
  private event(method: string, params: any, sessionId?: string) {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') this.upsert(params.targetInfo, this.discoverReady);
    if (method === 'Target.targetDestroyed') {
      this.tabs.delete(params.targetId); this.sessions.delete(params.targetId); this.provenance.delete(params.targetId);
      if (this.activeTargetId === params.targetId) this.activeTargetId = this.tabs.keys().next().value;
      this.emit('target.closed', params.targetId); this.emit('tabs');
    }
    if (method === 'Target.detachedFromTarget') {
      const target = this.targetsBySession.get(params.sessionId);
      if (target) { this.sessions.delete(target); this.targetsBySession.delete(params.sessionId); this.emit('target.detached', target); }
    }
    const targetId = sessionId && this.targetsBySession.get(sessionId);
    if (!targetId) {
      if (method === 'Page.screencastFrame') this.emit('event', method, params, undefined, sessionId);
      return;
    }
    const tab = this.tabs.get(targetId);
    if (tab && (method === 'Page.frameStartedLoading' || method === 'Page.frameStoppedLoading' || method === 'Page.lifecycleEvent')) {
      if (method === 'Page.frameStartedLoading' || params.name === 'init') tab.loading = true;
      if (method === 'Page.frameStoppedLoading' || params.name === 'load') { tab.loading = false; void this.history(targetId).catch(() => {}); }
      this.emit('tabs');
    }
    if (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument') void this.history(targetId).catch(() => {});
    if (method === 'Page.javascriptDialogOpening') this.emit('dialog', { t: 'dialog', targetId, type: params.type, message: params.message, defaultPrompt: params.defaultPrompt });
    if (method === 'Page.javascriptDialogClosed') this.emit('dialog', { t: 'dialog.closed', targetId });
    this.emit('event', method, params, targetId, sessionId);
  }
  async session(targetId: string): Promise<string> {
    if (!this.tabs.has(targetId)) throw new Error('Unknown tab');
    let promise = this.sessions.get(targetId);
    if (!promise) {
      promise = (async () => {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        this.targetsBySession.set(sessionId, targetId);
        await this.send('Page.enable', {}, sessionId);
        await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId);
        return sessionId as string;
      })();
      this.sessions.set(targetId, promise);
      promise.catch(() => { if (this.sessions.get(targetId) === promise) this.sessions.delete(targetId); });
    }
    return promise;
  }
  async page(targetId: string, method: string, params: Record<string, unknown> = {}, guard?: () => void) {
    const sessionId = await this.session(targetId);
    for (let attempt = 0; ; attempt++) {
      guard?.();
      try { return await this.send(method, params, sessionId); }
      catch (error) {
        // This error means Neo rejected dispatch during a renderer swap; no action ran.
        if (!(error instanceof CdpError) || !error.inactivePage || attempt >= 19) throw error;
        await Bun.sleep(50);
      }
    }
  }
  async history(targetId: string) {
    const { currentIndex, entries } = await this.page(targetId, 'Page.getNavigationHistory');
    const tab = this.tabs.get(targetId);
    if (tab) { tab.canGoBack = currentIndex > 0; tab.canGoForward = currentIndex < entries.length - 1; this.emit('tabs'); }
    return { currentIndex, entries };
  }
  async newTab(input = 'about:blank', guard?: () => void) {
    const url = navigationUrl(input);
    guard?.(); this.humanCreates++;
    try {
      const { targetId } = await this.send('Target.createTarget', { url });
      const tab = this.tabs.get(targetId); if (tab) tab.opener = 'human'; this.provenance.set(targetId, 'human');
      this.activeTargetId = targetId; this.emit('tabs'); return { targetId, url };
    } finally { this.humanCreates--; }
  }
  async activate(targetId: string, guard?: () => void) { guard?.(); if (!this.tabs.has(targetId)) throw new Error('Unknown tab'); await this.send('Target.activateTarget', { targetId }); this.activeTargetId = targetId; this.emit('tabs'); }
  async navigate(targetId: string, input: string, guard?: () => void) { const url = navigationUrl(input); await this.page(targetId, 'Page.navigate', { url }, guard); await this.history(targetId); return url; }
  async moveHistory(targetId: string, direction: number, guard?: () => void) {
    const { entries, currentIndex } = await this.history(targetId);
    const entry = entries[currentIndex + direction]; if (entry) await this.page(targetId, 'Page.navigateToHistoryEntry', { entryId: entry.id }, guard);
    await this.history(targetId);
  }
  close() { this.stopped = true; clearTimeout(this.retry); this.ws?.close(); this.lost(); }
}
