import { expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

const env = { TANDEM_PUBLIC_ORIGIN: 'https://tandem.example.com', TANDEM_AGENT_TOKEN: 'throwaway-agent-token-0000000000000000', TANDEM_VIEWER_AUTH: 'tailscale', TANDEM_PRIVATE_LISTEN: '0.0.0.0:8791' };
test('tailscale configuration needs no password or TOTP and ignores supplied secrets', async () => {
  const config = await loadConfig(env);
  expect(config.viewerAuth).toBe('tailscale'); expect(config.passwordHash).toBe(''); expect(config.totpSecret).toBeUndefined(); expect(config.tailscaleUsers).toEqual([]);
  expect(config.privateListen).toEqual({ hostname: '0.0.0.0', port: 8791 });
  const ignored = await loadConfig({ ...env, TANDEM_PASSWORD_HASH: 'not-a-hash', TANDEM_TOTP_SECRET: 'not-base32!' });
  expect(ignored.passwordHash).toBe(''); expect(ignored.totpSecret).toBeUndefined();
  expect((await loadConfig({ ...env, TANDEM_TAILSCALE_USERS: ' Samin@AIAnswer.us, ,owner@example.com ' })).tailscaleUsers).toEqual(['samin@aianswer.us', 'owner@example.com']);
});
test('tailscale configuration requires a distinct valid private listener', async () => {
  await expect(loadConfig({ ...env, TANDEM_PRIVATE_LISTEN: undefined })).rejects.toThrow('TANDEM_PRIVATE_LISTEN: required');
  await expect(loadConfig({ ...env, TANDEM_PRIVATE_LISTEN: '0.0.0.0:8790' })).rejects.toThrow('must differ from TANDEM_LISTEN');
  await expect(loadConfig({ ...env, TANDEM_LISTEN: 'localhost:8790', TANDEM_PRIVATE_LISTEN: 'LOCALHOST:08790' })).rejects.toThrow('must differ from TANDEM_LISTEN');
  for (const value of ['', '8791', 'localhost:0', 'localhost:65536', 'localhost:no']) await expect(loadConfig({ ...env, TANDEM_PRIVATE_LISTEN: value })).rejects.toThrow('TANDEM_PRIVATE_LISTEN');
  expect((await loadConfig({ ...env, TANDEM_PRIVATE_LISTEN: '[::1]:8791' })).privateListen).toEqual({ hostname: '::1', port: 8791 });
});
test('viewer auth defaults to password and rejects unknown modes', async () => {
  await expect(loadConfig({ ...env, TANDEM_VIEWER_AUTH: undefined })).rejects.toThrow('TANDEM_PASSWORD_HASH');
  await expect(loadConfig({ ...env, TANDEM_VIEWER_AUTH: 'none' })).rejects.toThrow('TANDEM_VIEWER_AUTH');
});
