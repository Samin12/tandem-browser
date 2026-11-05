import type { Cdp } from './cdp';
import type { Control } from './control';

export class Follow {
  private viewers = new Set<object>();
  private pending?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private last = -Infinity;
  constructor(private cdp: Cdp, private control: Control) {}
  set(viewer: object, enabled: boolean) { if (enabled) this.viewers.add(viewer); else this.viewers.delete(viewer); this.changed(); }
  changed() { if (!this.viewers.size || this.control.controller !== 'agent') { clearTimeout(this.timer); this.timer = undefined; this.pending = undefined; } }
  activity(targetId: string) {
    if (!this.viewers.size || this.control.controller !== 'agent') return;
    this.pending = targetId;
    if (this.timer) return;
    const delay = 500 - (Date.now() - this.last);
    if (delay <= 0) this.flush(); else this.timer = setTimeout(() => this.flush(), delay);
  }
  private flush() {
    this.timer = undefined;
    const targetId = this.pending; this.pending = undefined;
    if (!targetId || !this.viewers.size || this.control.controller !== 'agent') return;
    this.last = Date.now();
    void this.cdp.activate(targetId).catch(() => {});
  }
  close() { clearTimeout(this.timer); this.viewers.clear(); this.pending = undefined; }
}
