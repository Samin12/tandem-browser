import { NekoClient, WebRTCTransport, mount } from '@m1k1o/neko';
import { remoteSize } from './neo-resize';
import { replayNekoClick, sendNekoKeys, TransportFallback } from './neo-transport';
import type { Click } from './neo-transport';
import type { KeyStroke } from './neo-input';

// Only neko's video and input overlay; Tandem owns authentication, chrome and control.
export class NekoView {
  private transport = new WebRTCTransport();
  private client = new NekoClient({ autoplay: true, autologin: false, autoconnect: false, transport: this.transport });
  private inputOpen = false;
  private unbindInput = () => {};
  private cleanup: (() => void)[] = [];
  private stopped = false;
  private allowed = false;
  private frame = false;
  private mediaConnected = false;
  private guard = new TransportFallback(Date.now());
  private screenTimer?: ReturnType<typeof setTimeout>;
  constructor(private container: HTMLElement, private scale: number,
    private sendScreen: (message: { t: 'screen'; w: number; h: number }) => void,
    private state: (live: boolean) => void, private controlChanged: () => void,
    private clipboard: (text: string) => void, private fallback: () => void) {
    const client = this.client;
    // bind() is public on DataChannelInput; wait for open before replaying the first click.
    const bind = this.transport.input.bind.bind(this.transport.input);
    this.transport.input.bind = channel => {
      this.unbindInput();
      bind(channel); this.inputOpen = channel?.readyState === 'open';
      const changed = () => { this.inputOpen = channel?.readyState === 'open'; this.controlChanged(); };
      channel?.addEventListener('open', changed);
      channel?.addEventListener('close', changed);
      this.unbindInput = () => { channel?.removeEventListener('open', changed); channel?.removeEventListener('close', changed); };
      this.controlChanged();
    };
    this.cleanup.push(() => { this.unbindInput(); this.transport.input.bind = bind; });
    client.setUrl(new URL('/neko', location.href).href);
    client.lock();
    this.cleanup.push(mount(client, container));
    client.mute(); client.setScrollInverse(false);
    // Even if neko's host event beats Tandem's acknowledgment, no device may send input.
    for (const method of ['key', 'move', 'button', 'scroll', 'touch'] as const) {
      const original = client.input[method].bind(client.input) as (...args: any[]) => void;
      (client.input[method] as (...args: any[]) => void) = (...args) => { if (this.canInput()) original(...args); };
    }
    this.cleanup.push(client.store.subscribe(s => s.control.host_id, () => this.controlChanged()));
    this.cleanup.push(client.transport.on('state', s => {
      this.mediaConnected = s.status === 'connected';
      this.connection(); this.controlChanged();
    }));
    this.cleanup.push(client.events.on('connection.status', () => { this.connection(); this.resize(); }));
    this.cleanup.push(client.events.on('room.clipboard.updated', text => this.clipboard(text)));
    const video = client.transport.element as HTMLVideoElement;
    // A decoded frame, rather than a socket or ICE connection, ends the initial timeout.
    const received = () => { if (!this.stopped) { this.frame = true; this.guard.frame(); this.connection(); this.controlChanged(); } };
    if (video.requestVideoFrameCallback) {
      const callback = video.requestVideoFrameCallback(received);
      this.cleanup.push(() => video.cancelVideoFrameCallback(callback));
    } else {
      video.addEventListener('loadeddata', received, { once: true });
      this.cleanup.push(() => video.removeEventListener('loadeddata', received));
    }
    const observer = new ResizeObserver(() => this.resize()); observer.observe(container);
    this.cleanup.push(() => observer.disconnect());
    const timer = setInterval(() => {
      if (this.guard.expired(Date.now())) this.fallback();
    }, 100);
    this.cleanup.push(() => clearInterval(timer));
    this.resize();
    // /api/me already authenticated Tandem. The gateway authenticates the signalling
    // socket server-side; no neko login, token or browser-side REST call is needed.
    client.store.setState({ authenticated: true }); client.connect();
  }
  private connection() {
    const live = this.mediaConnected && this.client.state.connection.status === 'connected';
    this.guard.connection(live, Date.now()); this.state(live && this.frame);
  }
  canInput() { return !this.stopped && this.allowed && this.inputOpen && this.frame && this.mediaConnected && this.client.controlling && this.client.state.connection.status === 'connected'; }
  setControl(allowed: boolean) {
    this.allowed = allowed;
    if (allowed) this.client.unlock(); else this.client.lock();
  }
  resize() {
    clearTimeout(this.screenTimer);
    this.screenTimer = setTimeout(() => {
      if (this.stopped || this.client.state.connection.status !== 'connected') return;
      const rect = this.container.getBoundingClientRect();
      if (rect.width && rect.height) this.sendScreen({ t: 'screen', ...remoteSize({ w: rect.width, h: rect.height }, this.scale) });
    }, 500);
  }
  focus() { this.container.querySelector('textarea')?.focus({ preventScroll: true }); }
  send(sequence: KeyStroke[]) { if (this.canInput()) sendNekoKeys(this.client.input, sequence); }
  replay(click: Click) {
    const input = this.container.querySelector('textarea');
    if (!this.canInput() || !input) return;
    this.focus(); replayNekoClick(this.client.input, click, input.getBoundingClientRect(), this.client.state.screen.size);
  }
  async paste(text: string) {
    if (!this.canInput()) return;
    // Explicit local paste wins even when the remote clipboard changed recently.
    // preparePaste intentionally prefers recent remote text, so use clipboard/set here.
    await new Promise<void>(resolve => {
      const off = this.client.events.on('room.clipboard.updated', value => { if (value === text) { clearTimeout(timer); off(); resolve(); } });
      const timer = setTimeout(() => { off(); resolve(); }, 500);
      this.client.send('clipboard/set', { text });
    });
  }
  stop() {
    this.stopped = true; clearTimeout(this.screenTimer);
    this.cleanup.splice(0).reverse().forEach(off => off()); this.client.disconnect();
  }
}
