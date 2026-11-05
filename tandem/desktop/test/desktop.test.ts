import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanConfig, loadConfig, saveConfig } from '../src/config';
import { commandMenuItem, controlCommands, editCommands, navigationCommands, tabCommands } from '../src/commands';
import { isDesktopPopup, isExternalURL, isSameOrigin, validateServerURL } from '../src/policy';

describe('server URL validation', () => {
  test('normalizes HTTPS and permits the two local HTTP hosts', () => {
    expect(validateServerURL(' https://Browser.Example.com:443/ ')).toBe('https://browser.example.com');
    expect(validateServerURL('http://localhost:8790')).toBe('http://localhost:8790');
    expect(validateServerURL('http://127.0.0.1:8790/')).toBe('http://127.0.0.1:8790');
  });
  test.each(['', 'browser.example.com', 'http://browser.example.com', 'http://localhost.evil.com', 'http://[::1]:8790', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://example.com/viewer', 'https://example.com/?token=secret', 'https://example.com/#fragment'])('rejects %s', value => {
    expect(() => validateServerURL(value)).toThrow();
  });
});

describe('origin and popup policy', () => {
  const origin = 'https://browser.example.com';
  test('permits paths on the exact configured origin', () => {
    expect(isSameOrigin(`${origin}/login`, origin)).toBe(true);
    expect(isSameOrigin(`${origin}:443/a`, origin)).toBe(true);
    expect(isDesktopPopup(`${origin}/desktop/vnc.html`, origin)).toBe(true);
  });
  test.each(['https://evil.com', 'https://browser.example.com.evil.com', 'https://browser.example.com:444', 'http://browser.example.com', 'file:///tmp/test', 'data:text/html,hi', 'https://user@browser.example.com', 'not a url'])('refuses navigation / bridge on %s', value => {
    expect(isSameOrigin(value, origin)).toBe(false);
    expect(isDesktopPopup(value, origin)).toBe(false);
  });
  test('only allows desktop paths as popups and HTTP(S) externally', () => {
    expect(isDesktopPopup(`${origin}/desktop`, origin)).toBe(false);
    expect(isDesktopPopup(`${origin}/desktop-evil/`, origin)).toBe(false);
    expect(isDesktopPopup(`${origin}/login`, origin)).toBe(false);
    expect(isExternalURL('https://example.com')).toBe(true);
    expect(isExternalURL('mailto:a@example.com')).toBe(false);
    expect(isExternalURL('javascript:alert(1)')).toBe(false);
  });
});

test('every native command handler sends the exact protocol command', () => {
  const items = [...tabCommands, ...navigationCommands, ...editCommands, ...controlCommands('Hermes')];
  const sent: string[] = [];
  for (const item of items) commandMenuItem(item, command => sent.push(command)).click();
  expect(sent).toEqual([
    'new-tab', 'close-tab', 'focus-address', 'next-tab', 'prev-tab',
    ...Array.from({ length: 9 }, (_, i) => `select-tab:${i + 1}`),
    'reload', 'stop', 'back', 'forward', 'edit-undo', 'edit-redo', 'edit-cut', 'edit-copy', 'edit-paste', 'edit-select-all',
    'take-control', 'release-control', 'mode-watch', 'mode-agent', 'mode-manual', 'open-desktop-view', 'show-audit', 'logout'
  ]);
  expect(new Set(sent).size).toBe(sent.length);
  expect(items.find(item => item.command === 'release-control')?.accelerator).toBe('CmdOrCtrl+Shift+H');
});

describe('configuration persistence', () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function file() {
    const dir = await mkdtemp(path.join(import.meta.dir, '.config-test-'));
    directories.push(dir); return path.join(dir, 'nested', 'config.json');
  }
  test('missing config starts with settings, save round-trips atomically with private permissions', async () => {
    const target = await file();
    expect(await loadConfig(target)).toEqual({});
    const config = { serverURL: 'https://browser.example.com', window: { width: 1280, height: 840, x: -1500, y: 50, maximized: true } };
    await saveConfig(target, config);
    expect(await loadConfig(target)).toEqual(config);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await saveConfig(target, { serverURL: 'http://localhost:8790' });
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ serverURL: 'http://localhost:8790' });
    expect(await Bun.file(`${target}.tmp`).exists()).toBe(false);
  });
  test('corrupt and unsafe config is ignored', async () => {
    const target = await file();
    await saveConfig(target, {}); await writeFile(target, '{oops');
    expect(await loadConfig(target)).toEqual({});
    expect(cleanConfig({ serverURL: 'http://evil.com', window: { width: -1, height: 20 }, secret: 'discard' })).toEqual({});
    expect(cleanConfig(null)).toEqual({});
    expect(cleanConfig({ window: { width: 800, height: 600, x: 'invalid', y: 20 } })).toEqual({ window: { width: 800, height: 600, maximized: false } });
  });
});
