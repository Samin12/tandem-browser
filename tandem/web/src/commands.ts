export const editCommands = ['edit-undo', 'edit-redo', 'edit-cut', 'edit-copy', 'edit-paste', 'edit-select-all'] as const;
export type EditCommand = typeof editCommands[number];
export function commandRoute(command: string, addressFocused: boolean): 'address' | 'remote' | 'browser' {
  return (editCommands as readonly string[]).includes(command) ? addressFocused ? 'address' : 'remote' : 'browser';
}
export function selectedTabIndex(command: string, current: number, count: number): number | null {
  if (!count) return null;
  if (command === 'next-tab') return (current + 1 + count) % count;
  if (command === 'prev-tab') return (current - 1 + count) % count;
  const match = /^select-tab:([1-9])$/.exec(command);
  if (!match) return null;
  return Number(match[1]) === 9 ? count - 1 : Math.min(Number(match[1]) - 1, count - 1);
}
