import { contextBridge, ipcRenderer } from 'electron';

if (process.isMainFrame && window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('tandemLocal', {
    config: () => ipcRenderer.invoke('local:config'),
    health: (url: string) => ipcRenderer.invoke('local:health', url),
    save: (url: string) => ipcRenderer.invoke('local:save', url),
    retry: () => ipcRenderer.send('local:retry'),
    settings: () => ipcRenderer.send('local:settings'),
    source: () => ipcRenderer.send('local:source')
  });
}
