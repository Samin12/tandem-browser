import { NekoView } from './neo-neko';
import { ClickReplay, selectTransport } from './neo-transport';
import type { NeoTransport } from './neo-transport';
import { enableViewerResize } from './neo-resize';
import { commandShortcut, macKeyRoute, macKeySequence, shortcutSequence, viewOnly } from './neo-input';
import type { KeyStroke } from './neo-input';
import type { Control } from './types';
interface RFB extends EventTarget {
  // Compatibility surface for the engine's pinned noVNC 1.3 module.
  _viewOnly: boolean; _requestRemoteResize(): void; _screenSize(): { w: number; h: number };
  scaleViewport: boolean; resizeSession: boolean; viewOnly: boolean; focusOnClick: boolean;
  background: string; qualityLevel: number; compressionLevel: number;
  disconnect(): void; focus(): void; sendKey(keysym: number, code: string, down: boolean): void;
  clipboardPasteFrom(text: string): void;
}
type RFBConstructor = new (container: HTMLElement, url: string, options: { shared: boolean }) => RFB;
export type NeoStatus = 'connecting' | 'live' | 'reconnecting' | 'paused';
export class NeoView {
  private rfb?: RFB;
  private neko?: NekoView;
  private fellBack = false;
  transport: NeoTransport = 'VNC';
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private pasteTimer?: ReturnType<typeof setTimeout>;
  private pasteVersion = 0;
  private control: Control = { controller: 'agent', yours: false, since: 0, agentBusy: false, pendingAgentCalls: 0 };
  private viewerConnected = false;
  private ready = false;
  private suppressed = new Set<string>();
  private pendingClick = new ClickReplay();
  constructor(private container: HTMLElement, private mac: boolean, private background: string,
    private status: (status: NeoStatus) => void, private notify: (text: string, takeControl?: boolean) => void,
    private takeControl: () => void, private sendScreen: (message: { t: 'screen'; w: number; h: number }) => void) {
    // Clicking the page grabs the wheel: take control, then replay that click once input is allowed.
    container.addEventListener('pointerdown', event => {
      if (this.canInput() || !this.ready) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.button !== 0 && event.button !== 2) return;
      this.pendingClick.queue({ x: event.clientX, y: event.clientY, button: event.button, at: Date.now() });
      this.takeControl();
    }, true);
    container.addEventListener('mousedown', event => {
      if (this.neko && !this.canInput()) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    container.addEventListener('keydown', event => this.keydown(event), true);
    container.addEventListener('keyup', event => {
      if (this.suppressed.delete(event.code)) { event.preventDefault(); event.stopImmediatePropagation(); }
      else if (this.mac && macKeyRoute(event) === 'local') event.stopImmediatePropagation();
    }, true);
    container.addEventListener('paste', event => {
      if (!this.canInput()) return;
      event.preventDefault(); event.stopImmediatePropagation();
      clearTimeout(this.pasteTimer); this.pasteVersion++;
      void this.paste(event.clipboardData?.getData('text/plain')).catch(() => this.notify('Unable to read the clipboard. Try pasting again.'));
    }, true);
  }
  start() { if (!this.stopped) return; this.stopped = false; this.attempt = 0; void this.connect(); }
  stop() {
    this.stopped = true; this.generation++; this.ready = false; clearTimeout(this.retry); clearTimeout(this.pasteTimer);
    this.pasteVersion++; this.pendingClick.clear(); this.neko?.stop(); this.neko = undefined; this.rfb?.disconnect(); this.rfb = undefined; this.container.replaceChildren();
  }
  setControl(control: Control, connected: boolean) {
    const wasConnected = this.viewerConnected;
    this.control = control; this.viewerConnected = connected;
    this.neko?.setControl(!viewOnly(control, connected));
    if (connected && !wasConnected) this.neko?.resize();
    const readonly = viewOnly(control, connected);
    if (this.rfb && this.rfb.viewOnly !== readonly) this.rfb.viewOnly = readonly;
    this.replayClick();
  }
  private replayClick() {
    const click = this.pendingClick.take(this.canInput(), Date.now());
    if (!click) return;
    if (this.neko) { this.neko.replay(click); return; }
    const canvas = this.container.querySelector('canvas');
    if (!canvas) return;
    this.rfb!.focus();
    const init = { clientX: click.x, clientY: click.y, button: click.button, buttons: click.button === 2 ? 2 : 1, bubbles: true, cancelable: true, view: window };
    canvas.dispatchEvent(new MouseEvent('mousemove', { ...init, buttons: 0 }));
    canvas.dispatchEvent(new MouseEvent('mousedown', init));
    canvas.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  }
  focus() { if (this.neko) this.neko.focus(); else this.rfb?.focus(); }
  private canInput() { return this.ready && !this.stopped && !viewOnly(this.control, this.viewerConnected) && (!this.neko || this.neko.canInput()); }
  private send(sequence: KeyStroke[]) {
    if (!this.canInput()) return;
    if (this.neko) this.neko.send(sequence);
    else for (const stroke of sequence) this.rfb!.sendKey(...stroke);
  }
  async command(command: string): Promise<boolean> {
    const shortcut = commandShortcut(command);
    if (!shortcut) return false;
    if (!this.canInput()) { this.notify('Take control first', true); return true; }
    this.focus();
    if (command === 'edit-paste') await this.paste();
    else this.send(shortcutSequence(shortcut));
    return true;
  }
  private keydown(event: KeyboardEvent) {
    if (!this.canInput()) return;
    const route = this.mac ? macKeyRoute(event) : 'native';
    if (route === 'local') { event.stopImmediatePropagation(); return; }
    const paste = route === 'paste' || event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v';
    if (paste) {
      event.stopImmediatePropagation(); this.suppressed.add(event.code);
      if (event.repeat) { event.preventDefault(); return; }
      if (window.tandemDesktop) {
        event.preventDefault(); void this.paste().catch(() => this.notify('Unable to read the clipboard.'));
      } else {
        // Keep the browser's native paste event (clipboardData needs no read permission).
        // If it cannot deliver one to the canvas, fall back to the Clipboard API.
        const version = ++this.pasteVersion;
        clearTimeout(this.pasteTimer);
        this.pasteTimer = setTimeout(() => {
          if (version === this.pasteVersion) void this.paste().catch(() => this.notify('Allow clipboard access, then paste again.'));
        }, 150);
      }
      return;
    }
    if (route === 'remap') {
      event.preventDefault(); event.stopImmediatePropagation(); this.suppressed.add(event.code);
      this.send(macKeySequence(event));
    }
  }
  private async paste(text?: string) {
    const rfb = this.rfb, neko = this.neko;
    text ??= window.tandemDesktop ? window.tandemDesktop.readClipboard() : await navigator.clipboard.readText();
    if (!this.canInput() || this.rfb !== rfb || this.neko !== neko) return;
    if (neko) await neko.paste(text.slice(0, 100000));
    else rfb!.clipboardPasteFrom(text.slice(0, 100000));
    // Xvnc/vncconfig acquire the X selection asynchronously after the clipboard
    // notification. Give that ownership change a turn before Chromium pastes.
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!this.canInput() || this.rfb !== rfb || this.neko !== neko) return;
    this.send(shortcutSequence({ key: 'v', code: 'KeyV', ctrl: true }));
  }
  private async connect() {
    const generation = ++this.generation;
    this.status(this.attempt ? 'reconnecting' : 'connecting');
    try {
      const auth = await fetch('/api/me', { cache: 'no-store' });
      if (this.stopped || generation !== this.generation) return;
      if (auth.status === 401) { location.assign('/login'); return; }
      if (!auth.ok) throw new Error('Connection unavailable');
      const me = await auth.json().catch(() => ({})) as { displayScale?: unknown; webrtc?: unknown };
      const scale = typeof me.displayScale === 'number' && me.displayScale >= 1 && me.displayScale <= 3 ? me.displayScale : 1;
      this.transport = selectTransport(me.webrtc, this.fellBack);
      if (this.transport === 'WebRTC') {
        let wasLive = false;
        this.container.replaceChildren();
        this.neko = new NekoView(this.container, scale, this.sendScreen, (live, paused) => {
          if (this.stopped || generation !== this.generation) return;
          this.ready = live; this.status(paused ? 'paused' : live ? 'live' : wasLive ? 'reconnecting' : 'connecting');
          wasLive ||= live;
        }, () => this.replayClick(), text => this.writeClipboard(text), () => {
          if (this.stopped || generation !== this.generation) return;
          this.fellBack = true; this.neko?.stop(); this.neko = undefined; this.ready = false;
          this.pasteVersion++; void this.connect();
        });
        this.neko.setControl(!viewOnly(this.control, this.viewerConnected));
        return;
      }
      // A runtime specifier keeps the engine's noVNC ES modules out of our bundle.
      const path = '/desktop/core/' + 'rfb.js';
      const { default: RFB } = await import(/* @vite-ignore */ path) as { default: RFBConstructor };
      if (this.stopped || generation !== this.generation) return;
      this.container.replaceChildren();
      const rfb = this.rfb = new RFB(this.container, `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/desktop/websockify`, { shared: true });
      enableViewerResize(rfb, scale);
      rfb.scaleViewport = true; rfb.resizeSession = true; rfb.focusOnClick = true;
      rfb.viewOnly = viewOnly(this.control, this.viewerConnected);
      rfb.background = this.background; rfb.qualityLevel = 8; rfb.compressionLevel = 2;
      rfb.addEventListener('connect', () => {
        if (this.stopped || this.rfb !== rfb) return;
        this.ready = true; this.attempt = 0; this.status('live');
      });
      rfb.addEventListener('disconnect', event => {
        if (this.stopped || this.rfb !== rfb) return;
        this.ready = false; this.rfb = undefined;
        const detail = (event as CustomEvent<{ code?: number }>).detail;
        if (detail?.code === 4401) { location.assign('/login'); return; }
        // noVNC 1.3 doesn't expose the upstream close code; recheck the session.
        this.reconnect();
      });
      rfb.addEventListener('securityfailure', () => { if (!this.stopped && this.rfb === rfb) location.assign('/login'); });
      rfb.addEventListener('clipboard', event => {
        if (this.stopped || this.rfb !== rfb) return;
        this.writeClipboard(String((event as CustomEvent<{ text: string }>).detail.text));
      });
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        console.warn('Neo connection failed.', error);
        if (this.transport === 'WebRTC') { this.fellBack = true; this.neko?.stop(); this.neko = undefined; }
        const rfb = this.rfb; this.rfb = undefined; rfb?.disconnect(); this.ready = false;
        this.reconnect();
      }
    }
  }
  private writeClipboard(value: string) {
    const text = value.slice(0, 100000);
    if (window.tandemDesktop) window.tandemDesktop.writeClipboard(text);
    else void navigator.clipboard?.writeText(text).catch(() => this.notify('Allow clipboard access to copy from the browser.'));
  }
  private reconnect() {
    if (this.stopped) return;
    this.status('reconnecting'); clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), Math.min(30000, 700 * 2 ** this.attempt++) + Math.random() * 300);
  }
}
