import { describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { checkOrigin, clientIp, constantEqual, decodeBase32, encodeBase32, isPrivateProxy, navigationUrl, RateLimit, securityHeaders, totp, verifyTotp } from '../src/security';
import { loadConfig } from '../src/config';
import { inputCommand } from '../src/input';

const origin = 'https://browser.example.com';
describe('security', () => {
  test('RFC 6238 SHA1 vector (six digits), drift and invalid codes', () => {
    const secret = encodeBase32(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59000)).toBe('287082');
    expect(verifyTotp(secret, '287082', 59000)).toBe(true);
    expect(verifyTotp(secret, totp(secret, 89000), 59000)).toBe(true);
    expect(verifyTotp(secret, totp(secret, 119000), 59000)).toBe(false);
    expect(verifyTotp(secret, 287082, 59000)).toBe(false);
    expect(verifyTotp(secret, 'not-a-code', 59000)).toBe(false);
  });
  test('base32 round trip and strict padding', () => {
    const bytes = randomBytes(20); expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    expect(() => decodeBase32('!!!!!')).toThrow(); expect(() => decodeBase32('AB')).toThrow();
  });
  test('hashed constant-time equality supports unequal lengths', () => {
    expect(constantEqual('abc', 'abc')).toBe(true); expect(constantEqual('abc', 'abcd')).toBe(false);
  });
  test('five failures block for fifteen minutes, then expire', () => {
    const rate = new RateLimit();
    for (let i = 0; i < 5; i++) rate.fail('ip', 1000 + i);
    expect(rate.retryAfter('ip', 2000)).toBe(899); expect(rate.retryAfter('other', 2000)).toBe(0);
    expect(rate.retryAfter('ip', 901005)).toBe(0); rate.fail('ip', 901006); rate.clear('ip'); expect(rate.retryAfter('ip', 901007)).toBe(0);
  });
  test('XFF accepted only via private proxy, stops at first untrusted hop', () => {
    const req = new Request(origin, { headers: { 'x-forwarded-for': '1.1.1.1, 8.8.8.8, 10.0.0.2' } });
    expect(clientIp(req, '192.168.1.1')).toBe('8.8.8.8'); expect(clientIp(req, '9.9.9.9')).toBe('9.9.9.9');
    expect(isPrivateProxy('::1')).toBe(true); expect(isPrivateProxy('::ffff:127.0.0.1')).toBe(true); expect(isPrivateProxy('172.32.0.1')).toBe(false);
  });
  test('Origin and JSON CSRF checks, including WS upgrades', () => {
    expect(checkOrigin(new Request(origin), [origin])).toBe(true);
    expect(checkOrigin(new Request(origin), [origin], true)).toBe(false);
    expect(checkOrigin(new Request(origin, { method: 'POST', headers: { origin, 'content-type': 'application/json' } }), [origin])).toBe(false);
    expect(checkOrigin(new Request(origin, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-tandem': '1' } }), [origin])).toBe(true);
    expect(checkOrigin(new Request(origin, { headers: { origin: 'https://evil.example' } }), [origin], true)).toBe(false);
  });
  test('security headers and desktop-only CSP relaxation', () => {
    expect(securityHeaders('/api/me').get('cache-control')).toBe('no-store');
    expect(securityHeaders('/').get('content-security-policy')).not.toContain('unsafe-eval');
    expect(securityHeaders('/desktop/vnc.html').get('content-security-policy')).toContain('unsafe-eval');
    expect(securityHeaders('/').get('x-frame-options')).toBe('DENY');
  });
  test('URL rules support URLs, domains, newtab and searches', () => {
    expect(navigationUrl('https://example.com/path?q=a')).toBe('https://example.com/path?q=a');
    expect(navigationUrl('https://user:pass@example.com/')).toBe('https://user:pass@example.com/');
    expect(navigationUrl('example.com/foo')).toBe('https://example.com/foo');
    expect(navigationUrl('example.com:8443/path')).toBe('https://example.com:8443/path');
    expect(navigationUrl('two words')).toBe('https://www.google.com/search?q=two%20words');
    expect(navigationUrl('about:blank')).toBe('about:blank'); expect(navigationUrl('chrome://newtab')).toBe('chrome://newtab');
  });
  test('unsafe URL schemes and controls refused', () => {
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings', 'ftp://example.com', 'https://exa\nmple.com']) expect(() => navigationUrl(value)).toThrow();
  });
  test('typed mouse mapping rejects raw CDP and invalid input', () => {
    expect(inputCommand({ t: 'input.mouse', type: 'wheel', x: 10, y: 20, deltaY: -5 }).params).toMatchObject({ type: 'mouseWheel', deltaY: -5 });
    expect(() => inputCommand({ t: 'Input.dispatchMouseEvent' })).toThrow();
    expect(() => inputCommand({ t: 'input.mouse', type: 'down', x: NaN, y: 0 })).toThrow();
    expect(() => inputCommand({ t: 'input.text', text: 'x'.repeat(100001) })).toThrow();
  });
  test('key mapping passes only typed key fields', () => {
    const key = { t: 'input.key', type: 'down', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, text: 'a', evil: 1 };
    expect(inputCommand(key).params).toEqual({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 0, location: 0, autoRepeat: false, text: 'a', unmodifiedText: 'a' });
    delete (key as any).text; expect(inputCommand(key).params.type).toBe('rawKeyDown');
    expect(inputCommand({ ...key, type: 'up' }).params.type).toBe('keyUp');
  });
  test('config validates secrets, production, durations and origins without echoing them', async () => {
    const base = { TANDEM_ENV: 'development', TANDEM_PUBLIC_ORIGIN: 'http://127.0.0.1:8790', TANDEM_PASSWORD: randomBytes(16).toString('hex'), TANDEM_AGENT_TOKEN: randomBytes(32).toString('hex') };
    const config = await loadConfig(base); expect(config.passwordHash).toStartWith('$argon2id$'); expect(config.port).toBe(8790);
    await expect(loadConfig({ ...base, TANDEM_ENV: 'production', TANDEM_PUBLIC_ORIGIN: origin })).rejects.toThrow('development only');
    await expect(loadConfig({ ...base, TANDEM_AGENT_TOKEN: 'sensitive' })).rejects.toThrow('at least 32');
    await expect(loadConfig({ ...base, TANDEM_SESSION_IDLE_HOURS: '0' })).rejects.toThrow('positive');
    await expect(loadConfig({ ...base, TANDEM_PUBLIC_ORIGIN: origin + '/path' })).rejects.toThrow('without paths');
  });
});
