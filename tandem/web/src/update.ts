// A deploy changes the server's viewer build. The viewer reloads to pick it up,
// but never while its own user is driving: that waits until they hand control back.
export class BuildWatch {
  private build?: string;
  private pending = false;
  constructor(private reload: () => void, private deferred: () => void) {}
  welcome(build: unknown, driving: boolean) {
    if (typeof build !== 'string' || !build) return;
    if (this.build === undefined) { this.build = build; return; }
    if (build === this.build) return;
    if (driving) { if (!this.pending) { this.pending = true; this.deferred(); } return; }
    this.reload();
  }
  control(driving: boolean) { if (this.pending && !driving) this.reload(); }
}
