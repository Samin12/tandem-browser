import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateServerURL } from './policy';

export interface WindowState { width: number; height: number; x?: number; y?: number; maximized?: boolean }
export interface Config { serverURL?: string; window?: WindowState }

export function cleanConfig(value: unknown): Config {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: Config = {};
  try { if (raw.serverURL) result.serverURL = validateServerURL(raw.serverURL); } catch { /* Ignore stale or invalid configuration. */ }
  const w = raw.window as WindowState | undefined;
  if (w && Number.isInteger(w.width) && Number.isInteger(w.height) && w.width >= 640 && w.height >= 480 && w.width <= 16384 && w.height <= 16384) {
    result.window = { width: w.width, height: w.height, maximized: w.maximized === true };
    if (Number.isInteger(w.x) && Number.isInteger(w.y)) { result.window.x = w.x; result.window.y = w.y; }
  }
  return result;
}

export async function loadConfig(file: string): Promise<Config> {
  try { return cleanConfig(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveConfig(file: string, config: Config): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cleanConfig(config), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
