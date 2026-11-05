import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sessions, sessionCookie } from '../src/auth';
import { Audit } from '../src/audit';
import { Control } from '../src/control';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tandem-test-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const audit = new Audit(dir); cleanup.push(() => audit.close());
  return { dir, audit };
}
describe('sessions', () => {
  test('stores only token hashes, absolute and idle expiry, touch extends idle', () => {
    const { dir } = setup(), sessions = new Sessions({ dataDir: dir, idleMs: 100, maxMs: 250 }); cleanup.push(() => sessions.close());
    const { token, session } = sessions.create(1000); const req = new Request('http://test', { headers: { cookie: `tandem_session=${token}` } });
    expect(sessions.fromRequest(req, 1090)?.expiresAt).toBe(1190);
    expect(sessions.fromRequest(req, 1180)?.expiresAt).toBe(1250);
    expect(sessions.fromRequest(req, 1240)?.expiresAt).toBe(1250);
    expect(sessions.fromRequest(req, 1250)).toBeNull(); expect(sessions.byId(session.id, false, 1250)).toBeNull();
    const idle = sessions.create(2000); expect(sessions.byId(idle.session.id, false, 2100)).toBeNull();
    expect(readFileSync(join(dir, 'sessions.sqlite')).includes(Buffer.from(token))).toBe(false);
    expect(statSync(join(dir, 'sessions.sqlite')).mode & 0o777).toBe(0o600);
  });
  test('logout and sweep revoke active sessions with callbacks', () => {
    const { dir } = setup(), sessions = new Sessions({ dataDir: dir, idleMs: 100, maxMs: 500 }); cleanup.push(() => sessions.close());
    const ids: string[] = []; sessions.onRevoke = id => ids.push(id);
    const first = sessions.create(1000), second = sessions.create(1000);
    sessions.revoke(first.session.id); sessions.sweep(1100); expect(ids).toEqual([first.session.id, second.session.id]);
  });
  test('cookie flags secure in production and https development', () => {
    const config = { production: false, origins: ['http://localhost:8790', 'https://test.example'], maxMs: 3600000 };
    expect(sessionCookie('t', config, 'http://localhost:8790')).toBe('tandem_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600');
    expect(sessionCookie('t', config, 'https://test.example')).toContain('; Secure');
    expect(sessionCookie('', { ...config, production: true }, 'http://localhost:8790', true)).toContain('Max-Age=0; Secure');
  });
});
describe('audit', () => {
  test('redacts arguments, clipboard, URL paths, tokens and typed text', () => {
    const { dir, audit } = setup();
    audit.write('human', 'nav.go', { targetId: 'target', origin: 'https://example.com/private?token=secret', text: 'secret', password: 'secret' });
    audit.write('agent', 'agent.tool', { name: 'navigate', heldMs: 1.1, outcome: 'ok', arguments: { password: 'secret' }, token: 'secret' });
    audit.write('human', 'clipboard', { text: 'secret' });
    const content = readFileSync(audit.path, 'utf8'); expect(content).not.toContain('secret'); expect(content).not.toContain('/private');
    expect(audit.tail(10)).toHaveLength(2); expect(audit.tail(1)[0]?.detail).toEqual({ name: 'navigate', heldMs: 1, outcome: 'ok' });
    expect(statSync(join(dir, 'audit.log')).mode & 0o777).toBe(0o600);
  });
});
describe('control', () => {
  test('take replaces holder, only holder releases and held calls wake', async () => {
    const { dir, audit } = setup(), control = new Control(dir, audit, 1000); cleanup.push(() => control.close());
    control.connected('a'); control.connected('b'); control.take('a'); control.take('b');
    expect(control.release('a')).toBe(false); expect(control.state('b').yours).toBe(true);
    const waiting = control.waitForAgent(1000); expect(control.pendingAgentCalls).toBe(1);
    control.release('b'); expect(await waiting).toBe('ready'); expect(control.pendingAgentCalls).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).controller).toBe('agent');
  });
  test('all sockets disconnect for grace period, reconnect cancels release', async () => {
    const { dir, audit } = setup(), control = new Control(dir, audit, 30); cleanup.push(() => control.close());
    control.connected('a'); control.connected('a'); control.take('a'); control.disconnected('a');
    await Bun.sleep(40); expect(control.holds('a')).toBe(true);
    control.disconnected('a'); await Bun.sleep(10); control.connected('a'); await Bun.sleep(40); expect(control.holds('a')).toBe(true);
    control.disconnected('a'); await Bun.sleep(50); expect(control.controller).toBe('agent');
  });
  test('persisted human control restarts with a disconnect grace period', async () => {
    const { dir, audit } = setup(), first = new Control(dir, audit, 20); first.connected('a'); first.take('a'); first.close();
    const second = new Control(dir, audit, 20); cleanup.push(() => second.close());
    expect(second.holds('a')).toBe(true); await Bun.sleep(40); expect(second.controller).toBe('agent');
  });
  test('wait timeout and abort clean up counts', async () => {
    const { dir, audit } = setup(), control = new Control(dir, audit); cleanup.push(() => control.close()); control.take('a');
    expect(await control.waitForAgent(10)).toBe('timeout'); const abort = new AbortController(); const wait = control.waitForAgent(1000, abort.signal); abort.abort();
    expect(await wait).toBe('cancelled'); expect(control.pendingAgentCalls).toBe(0);
  });
  test('forwarded calls remain busy across human takeover', () => {
    const { dir, audit } = setup(), control = new Control(dir, audit); cleanup.push(() => control.close());
    control.started('navigate'); control.take('a'); expect(control.state('a').agentBusy).toBe(true);
    expect(control.state('a').lastAgentTool?.name).toBe('navigate'); control.finished(); expect(control.state('a').agentBusy).toBe(false);
  });
});
