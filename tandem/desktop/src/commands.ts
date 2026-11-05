export interface CommandItem { label: string; command: string; accelerator?: string }

export const tabCommands: CommandItem[] = [
  { label: 'New Tab', command: 'new-tab', accelerator: 'CmdOrCtrl+T' },
  { label: 'Close Tab', command: 'close-tab', accelerator: 'CmdOrCtrl+W' },
  { label: 'Open Location', command: 'focus-address', accelerator: 'CmdOrCtrl+L' },
  { label: 'Next Tab', command: 'next-tab', accelerator: 'Ctrl+Tab' },
  { label: 'Previous Tab', command: 'prev-tab', accelerator: 'Ctrl+Shift+Tab' },
  ...Array.from({ length: 9 }, (_, i) => ({ label: i === 8 ? 'Select Last Tab' : `Select Tab ${i + 1}`, command: `select-tab:${i + 1}`, accelerator: `CmdOrCtrl+${i + 1}` }))
];
export const navigationCommands: CommandItem[] = [
  { label: 'Reload Page', command: 'reload', accelerator: 'CmdOrCtrl+R' },
  { label: 'Stop', command: 'stop' },
  { label: 'Back', command: 'back', accelerator: 'CmdOrCtrl+[' },
  { label: 'Forward', command: 'forward', accelerator: 'CmdOrCtrl+]' }
];
export const editCommands: CommandItem[] = [
  { label: 'Undo', command: 'edit-undo', accelerator: 'CmdOrCtrl+Z' },
  { label: 'Redo', command: 'edit-redo', accelerator: 'CmdOrCtrl+Shift+Z' },
  { label: 'Cut', command: 'edit-cut', accelerator: 'CmdOrCtrl+X' },
  { label: 'Copy', command: 'edit-copy', accelerator: 'CmdOrCtrl+C' },
  { label: 'Paste', command: 'edit-paste', accelerator: 'CmdOrCtrl+V' },
  { label: 'Select All', command: 'edit-select-all', accelerator: 'CmdOrCtrl+A' }
];
export function controlCommands(agent: string): CommandItem[] {
  return [
    { label: 'Take Control', command: 'take-control', accelerator: 'CmdOrCtrl+Shift+M' },
    { label: `Hand Back to ${agent}`, command: 'release-control', accelerator: 'CmdOrCtrl+Shift+H' },
    { label: 'Watch Mode', command: 'mode-watch' },
    { label: 'Agent Mode', command: 'mode-agent' },
    { label: 'Manual Mode', command: 'mode-manual' },
    { label: 'Desktop View', command: 'open-desktop-view', accelerator: 'CmdOrCtrl+Shift+D' },
    { label: 'Audit Log', command: 'show-audit' },
    { label: 'Log Out', command: 'logout' }
  ];
}

export function commandMenuItem(item: CommandItem, send: (command: string) => void) {
  return { id: item.command, label: item.label, accelerator: item.accelerator, click: () => send(item.command) };
}
