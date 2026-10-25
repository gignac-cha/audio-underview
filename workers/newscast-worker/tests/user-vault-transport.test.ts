import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Environment } from '../sources/environment.ts';
import {
  ProviderKeyVaultUnavailableError,
  UserProviderKeyUnavailableError,
  createUserKeyTransport,
  isUserProviderKeyConfigured,
} from '../sources/user-vault-transport.ts';

const environment = env as unknown as Environment;

async function configureVault(userID: string, responses: Record<string, unknown>): Promise<void> {
  await environment.USER_VAULT.fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ userId: userID, responses }),
  });
}

async function vaultRequests(userID: string): Promise<Array<{ route: string; token: string | null; body: Record<string, unknown> }>> {
  const response = await environment.USER_VAULT.fetch(`https://stand-in.example.com/__test__/requests?userId=${userID}`);
  return response.json();
}

describe('createUserKeyTransport', () => {
  it('sends the request spec to /internal/proxy with the user, the provider and the internal token', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, {
      'proxy:google:v1beta/models/m:generateContent': { status: 200, body: { ok: true, provider: 'google', status: 200, body: '{"answer":1}' } },
    });

    const response = await createUserKeyTransport(environment, user, 'google')({
      path: 'v1beta/models/m:generateContent',
      method: 'POST',
      body: '{"question":1}',
      headers: { 'content-type': 'application/json' },
    });

    expect(response).toEqual({ status: 200, body: '{"answer":1}' });
    expect(await vaultRequests(user)).toEqual([{
      userId: user,
      route: 'proxy',
      method: 'POST',
      token: 'test-vault-token',
      body: {
        userId: user,
        provider: 'google',
        path: 'v1beta/models/m:generateContent',
        method: 'POST',
        body: '{"question":1}',
        headers: { 'content-type': 'application/json' },
      },
    }]);
  });

  it('passes a binary body as bodyBase64 and the provider status of an error as it is', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, { proxy: { status: 200, body: { ok: true, status: 401, body: 'rejected' } } });

    const response = await createUserKeyTransport(environment, user, 'openai')({
      path: 'v1/audio/transcriptions',
      method: 'POST',
      bodyBase64: 'QUJD',
    });

    expect(response).toEqual({ status: 401, body: 'rejected' });
    const [request] = await vaultRequests(user);
    expect(request.body).toMatchObject({ provider: 'openai', bodyBase64: 'QUJD' });
    expect(request.body).not.toHaveProperty('body');
  });

  it('throws UserProviderKeyUnavailableError when the vault has no key for the provider', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, { proxy: { status: 404, body: { ok: false, error: 'no_key' } } });

    const call = createUserKeyTransport(environment, user, 'xai')({ path: 'v1/chat/completions', method: 'POST', body: '{}' });

    await expect(call).rejects.toBeInstanceOf(UserProviderKeyUnavailableError);
  });

  it.each([
    ['a refused internal token', { status: 401, body: { error: 'unauthorized' } }, 'unauthorized'],
    ['a provider the vault could not reach', { status: 502, body: { ok: false, error: 'provider_unreachable' } }, 'provider_unreachable'],
    ['a vault without its key encryption key', { status: 503, body: { error: 'vault_unavailable' } }, 'vault_unavailable'],
    ['an answer that is not a provider response', { status: 200, body: { ok: true } }, 'unknown'],
  ])('throws the transient ProviderKeyVaultUnavailableError for %s', async (_case, answer, reason) => {
    const user = crypto.randomUUID();
    await configureVault(user, { proxy: answer });

    const error = await createUserKeyTransport(environment, user, 'google')({ path: 'p', method: 'POST', body: '{}' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderKeyVaultUnavailableError);
    expect((error as ProviderKeyVaultUnavailableError).reason).toBe(reason);
  });

  it('throws the transient error when the vault cannot be reached', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, { proxy: { status: 'unreachable' } });

    const call = createUserKeyTransport(environment, user, 'google')({ path: 'p', method: 'POST', body: '{}' });

    await expect(call).rejects.toBeInstanceOf(ProviderKeyVaultUnavailableError);
  });

  it('sends no token header when the worker has no internal token', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, { proxy: { status: 200, body: { ok: true, status: 200, body: '' } } });

    await createUserKeyTransport({ ...environment, VAULT_INTERNAL_TOKEN: undefined }, user, 'google')({ path: 'p', method: 'GET' });

    const [request] = await vaultRequests(user);
    expect(request.token).toBeNull();
  });
});

describe('isUserProviderKeyConfigured', () => {
  const KEYS = [
    { provider: 'google', configured: true, last4: 'abcd', validatedAt: '2026-10-26T00:00:00.000Z' },
    { provider: 'openai', configured: false, last4: null, validatedAt: null },
  ];

  it('reads /internal/keys/status with the user and the internal token, and answers for the provider asked', async () => {
    const user = crypto.randomUUID();
    await configureVault(user, { 'keys/status': { status: 200, body: { keys: KEYS } } });

    expect(await isUserProviderKeyConfigured(environment, user, 'google')).toBe(true);
    expect(await isUserProviderKeyConfigured(environment, user, 'openai')).toBe(false);
    expect(await isUserProviderKeyConfigured(environment, user, 'xai')).toBe(false);
    const [request] = await vaultRequests(user);
    expect(request).toEqual({ userId: user, route: 'keys/status', method: 'POST', token: 'test-vault-token', body: { userId: user } });
  });

  it.each([
    ['a vault that cannot be reached', { status: 'unreachable' }, 'Error'],
    ['a refused internal token', { status: 401, body: { error: 'unauthorized' } }, 'unauthorized'],
    ['a vault without its key encryption key', { status: 503, body: { error: 'vault_unavailable' } }, 'vault_unavailable'],
    ['an answer that is not a key list', { status: 200, body: { keys: null } }, 'unknown'],
  ])('throws the transient ProviderKeyVaultUnavailableError for %s', async (_case, answer, reason) => {
    const user = crypto.randomUUID();
    await configureVault(user, { 'keys/status': answer });

    const error = await isUserProviderKeyConfigured(environment, user, 'openai').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderKeyVaultUnavailableError);
    expect((error as ProviderKeyVaultUnavailableError).reason).toBe(reason);
  });
});
