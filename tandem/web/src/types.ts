export interface Brand {
  productName: string;
  shortName: string;
  tagline: string;
  agentName: string;
  colors: Record<string, string>;
  logo: string;
}
export interface RemoteTab {
  targetId: string; url: string; title: string; loading: boolean;
  canGoBack: boolean; canGoForward: boolean;
  opener: 'agent' | 'human' | 'unknown'; lastAgentActivityAt?: number;
}
export interface Control {
  controller: 'agent' | 'human'; holderSessionId?: string; holderLabel?: string;
  since: number; yours: boolean; agentBusy: boolean; pendingAgentCalls: number;
  lastAgentTool?: { name: string; at: number };
}
export interface FrameHeader {
  targetId: string; seq: number; deviceWidth: number; deviceHeight: number;
  offsetTop: number; pageScaleFactor: number; scrollOffsetX: number;
  scrollOffsetY: number; timestamp: number; format: 'jpeg';
}
export interface RemoteDialog {
  targetId: string; type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string; defaultPrompt?: string;
}
export type Message = { t: string; [key: string]: unknown };
export interface DesktopBridge {
  isDesktop: true; platform: 'darwin' | 'win32' | 'linux'; version: string;
  onCommand(cb: (command: string) => void): () => void;
  writeClipboard(text: string): void; readClipboard(): string; openSettings(): void;
}
declare global { interface Window { tandemDesktop?: DesktopBridge } }
