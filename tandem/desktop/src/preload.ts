import { contextBridge, ipcRenderer } from 'electron';

const origin = process.argv.find(arg => arg.startsWith('--tandem-origin='))?.slice('--tandem-origin='.length);
if (process.isMainFrame && origin && window.location.origin === origin) {
  contextBridge.exposeInMainWorld('tandemDesktop', {
    isDesktop: true,
    platform: process.platform,
    version: process.argv.find(arg => arg.startsWith('--tandem-version='))?.slice('--tandem-version='.length) ?? '',
    onCommand(callback: (command: string) => void) {
      if (typeof callback !== 'function') throw new TypeError('Expected a command callback.');
      const listener = (_event: Electron.IpcRendererEvent, command: string) => callback(command);
      ipcRenderer.on('tandem:command', listener);
      return () => ipcRenderer.removeListener('tandem:command', listener);
    },
    writeClipboard(text: string) {
      if (typeof text !== 'string') throw new TypeError('Expected text.');
      ipcRenderer.sendSync('tandem:clipboard-write', text);
    },
    readClipboard(): string { return ipcRenderer.sendSync('tandem:clipboard-read'); },
    openSettings(): void { ipcRenderer.send('tandem:settings'); }
  });
}
if (process.isMainFrame && window.location.protocol === 'file:' && window.location.pathname.endsWith('/pages/error.html')) {
  contextBridge.exposeInMainWorld('tandemLocal', {
    retry: () => ipcRenderer.send('local:retry'),
    settings: () => ipcRenderer.send('local:settings')
  });
}
