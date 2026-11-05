export type View = 'neo' | 'lite';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function persistView(view: View, storage: Storage) {
  try { storage.setItem('tandem.view', view); } catch { /* Optional preference. */ }
}
export function selectView(search: string, storage: Storage): View {
  const explicit = new URLSearchParams(search).get('view');
  if (explicit === 'neo' || explicit === 'lite') { persistView(explicit, storage); return explicit; }
  try { return storage.getItem('tandem.view') === 'lite' ? 'lite' : 'neo'; } catch { return 'neo'; }
}
