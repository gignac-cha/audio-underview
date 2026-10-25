import { describe, it, expect } from 'vitest';
import { UserVaultClient, UserVaultError } from '../sources/user-vault-client.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function createBinding(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const binding = {
    async fetch(input: string, init: RequestInit) {
      const request = new Request(input, init);
      const call = { url: request.url, headers: Object.fromEntries(request.headers), body: await request.json() };
      calls.push(call);
      return answer(call);
    },
  } as unknown as Fetcher;
  return { binding, calls };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('UserVaultClient', () => {
  it('calls the environment variable routes with userId, sending the token when it is set', async () => {
    const { binding, calls } = createBinding((call) => {
      const route = new URL(call.url).pathname;
      if (route.endsWith('/list')) return Response.json({ variables: [{ name: 'A', created_at: 'c', updated_at: 'u' }] });
      if (route.endsWith('/put')) return Response.json({ name: 'A', created_at: 'c', updated_at: 'u', created: true });
      if (route.endsWith('/delete')) return Response.json({ deleted: true });
      return Response.json({ variables: { A: 'value-a' } });
    });
    const client = new UserVaultClient(binding, 'vault-token');

    await expect(client.listEnvironmentVariables(USER)).resolves.toEqual([{ name: 'A', created_at: 'c', updated_at: 'u' }]);
    await expect(client.putEnvironmentVariable(USER, 'A', 'value-a')).resolves.toEqual({ name: 'A', created_at: 'c', updated_at: 'u', created: true });
    await expect(client.deleteEnvironmentVariable(USER, 'A')).resolves.toBe(true);
    await expect(client.resolveEnvironmentVariables(USER)).resolves.toEqual({ A: 'value-a' });

    expect(calls.map((call) => [new URL(call.url).pathname, call.body, call.headers['x-user-vault-token']])).toEqual([
      ['/internal/environment-variables/list', { userId: USER }, 'vault-token'],
      ['/internal/environment-variables/put', { userId: USER, name: 'A', value: 'value-a' }, 'vault-token'],
      ['/internal/environment-variables/delete', { userId: USER, name: 'A' }, 'vault-token'],
      ['/internal/environment-variables/resolve', { userId: USER }, 'vault-token'],
    ]);
  });

  it('calls the provider key routes with userId, sending the token when it is set', async () => {
    const status = { provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v' };
    const { binding, calls } = createBinding((call) => {
      const route = new URL(call.url).pathname;
      if (route.endsWith('/status')) return Response.json({ keys: [{ provider: 'anthropic', configured: false, last4: null, validatedAt: null }, status] });
      if (route.endsWith('/audit')) return Response.json({ events: [{ provider: 'google', action: 'registered', at: 'a' }] });
      if (route.endsWith('/put')) return Response.json(status);
      return Response.json({ removed: true });
    });
    const client = new UserVaultClient(binding, 'vault-token');
    const fingerprint = { ip: '203.0.113.7', userAgent: 'agent' };

    await expect(client.getProviderKeyStatus(USER)).resolves.toEqual([
      { provider: 'anthropic', configured: false, last4: null, validatedAt: null },
      status,
    ]);
    await expect(client.listProviderKeyAudit(USER, 50)).resolves.toEqual([{ provider: 'google', action: 'registered', at: 'a' }]);
    await expect(client.putProviderKey(USER, 'google', 'key-0123456789abcdef', fingerprint)).resolves.toEqual(status);
    await expect(client.deleteProviderKey(USER, 'google', fingerprint)).resolves.toBe(true);

    expect(calls.map((call) => [new URL(call.url).pathname, call.body, call.headers['x-user-vault-token']])).toEqual([
      ['/internal/keys/status', { userId: USER }, 'vault-token'],
      ['/internal/keys/audit', { userId: USER, limit: 50 }, 'vault-token'],
      ['/internal/keys/put', { userId: USER, provider: 'google', key: 'key-0123456789abcdef', ip: '203.0.113.7', userAgent: 'agent' }, 'vault-token'],
      ['/internal/keys/delete', { userId: USER, provider: 'google', ip: '203.0.113.7', userAgent: 'agent' }, 'vault-token'],
    ]);
    expect(calls.every((call) => call.url.startsWith('https://user-vault.internal/'))).toBe(true);
  });

  it('sends only the fingerprint fields it was given', async () => {
    const { binding, calls } = createBinding(() => Response.json({ removed: false }));
    const client = new UserVaultClient(binding, undefined);

    await client.deleteProviderKey(USER, 'xai', {});
    await client.deleteProviderKey(USER, 'xai', { ip: '203.0.113.7' });
    await client.deleteProviderKey(USER, 'xai', { userAgent: 'agent' });

    expect(calls.map((call) => call.body)).toEqual([
      { userId: USER, provider: 'xai' },
      { userId: USER, provider: 'xai', ip: '203.0.113.7' },
      { userId: USER, provider: 'xai', userAgent: 'agent' },
    ]);
  });

  it('passes only the known fields of a provider key answer on', async () => {
    const { binding } = createBinding((call) => {
      const extra = { ciphertext: 'must not pass', ipHash: 'must not pass' };
      if (call.url.endsWith('/status')) return Response.json({ keys: [{ provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v', ...extra }] });
      if (call.url.endsWith('/audit')) return Response.json({ events: [{ provider: 'google', action: 'used', at: 'a', ...extra }] });
      return Response.json({ provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v', ...extra });
    });
    const client = new UserVaultClient(binding, undefined);

    expect(await client.getProviderKeyStatus(USER)).toEqual([{ provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v' }]);
    expect(await client.listProviderKeyAudit(USER, 1)).toEqual([{ provider: 'google', action: 'used', at: 'a' }]);
    expect(await client.putProviderKey(USER, 'google', 'key-0123456789abcdef', {})).toEqual({ provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v' });
  });

  it('throws UserVaultError with the status and the code of a provider key answer other than 2xx, without the key', async () => {
    const { binding } = createBinding(() => Response.json({ error: 'invalid_key' }, { status: 400 }));

    const error = await new UserVaultClient(binding, undefined).putProviderKey(USER, 'google', 'key-0123456789abcdef', {}).catch((caught) => caught);

    expect(error).toBeInstanceOf(UserVaultError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_key', message: 'User vault responded 400 invalid_key' });
    expect(error.message).not.toContain('key-0123456789abcdef');
  });

  it('throws UserVaultError with status 0 when the vault cannot be reached for a provider key', async () => {
    const binding = { fetch: () => Promise.reject(new Error('connection refused key-0123456789abcdef')) } as unknown as Fetcher;
    const client = new UserVaultClient(binding, undefined);

    for (const error of [
      await client.getProviderKeyStatus(USER).catch((caught) => caught),
      await client.listProviderKeyAudit(USER, 50).catch((caught) => caught),
      await client.putProviderKey(USER, 'google', 'key-0123456789abcdef', {}).catch((caught) => caught),
      await client.deleteProviderKey(USER, 'google', {}).catch((caught) => caught),
    ]) {
      expect(error).toMatchObject({ status: 0, code: null, message: 'User vault could not be reached' });
    }
  });

  it('throws on a provider key answer of the wrong shape', async () => {
    const status = { provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v' };
    const wrongShapes: [string, (client: UserVaultClient) => Promise<unknown>, unknown[]][] = [
      ['status', (client) => client.getProviderKeyStatus(USER), [
        {},
        { keys: null },
        { keys: [{ ...status, provider: 'mistral' }] },
        { keys: [{ ...status, configured: 'true' }] },
        { keys: [{ ...status, last4: 1 }] },
        { keys: [{ ...status, validatedAt: undefined }] },
        { keys: ['google'] },
      ]],
      ['audit', (client) => client.listProviderKeyAudit(USER, 50), [
        {},
        { events: null },
        { events: [{ provider: 'mistral', action: 'used', at: 'a' }] },
        { events: [{ provider: 'google', action: 'rotated', at: 'a' }] },
        { events: [{ provider: 'google', action: 'used', at: 1 }] },
      ]],
      ['put', (client) => client.putProviderKey(USER, 'google', 'key-0123456789abcdef', {}), [
        {},
        { ...status, configured: false },
        { ...status, provider: 'mistral' },
        { ...status, last4: 1 },
        [status],
      ]],
      ['delete', (client) => client.deleteProviderKey(USER, 'google', {}), [
        {},
        { removed: 'true' },
        { deleted: true },
      ]],
    ];

    for (const [name, run, bodies] of wrongShapes) {
      for (const body of bodies) {
        const { binding } = createBinding(() => Response.json(body));

        await expect(run(new UserVaultClient(binding, undefined)), `${name} ${JSON.stringify(body)}`).rejects.toMatchObject({ code: 'invalid_response' });
      }
    }
  });

  it('does not send the token header when the token is empty or missing', async () => {
    for (const token of ['', undefined]) {
      const { binding, calls } = createBinding(() => Response.json({ variables: {} }));

      await new UserVaultClient(binding, token).resolveEnvironmentVariables(USER);

      expect(calls[0].headers).not.toHaveProperty('x-user-vault-token');
    }
  });

  it('throws UserVaultError with the status and the error code of an answer other than 2xx', async () => {
    const { binding } = createBinding(() => Response.json({ error: 'limit_exceeded' }, { status: 409 }));

    const error = await new UserVaultClient(binding, undefined).putEnvironmentVariable(USER, 'A', 'value-a').catch((caught) => caught);

    expect(error).toBeInstanceOf(UserVaultError);
    expect(error).toMatchObject({ status: 409, code: 'limit_exceeded', message: 'User vault responded 409 limit_exceeded' });
    expect(error.message).not.toContain('value-a');
  });

  it('throws UserVaultError without a code when the answer is not JSON', async () => {
    const { binding } = createBinding(() => new Response('bad gateway', { status: 502 }));

    await expect(new UserVaultClient(binding, undefined).resolveEnvironmentVariables(USER)).rejects.toMatchObject({ status: 502, code: null });
  });

  it('throws UserVaultError with status 0 when the vault cannot be reached', async () => {
    const binding = { fetch: () => Promise.reject(new Error('connection refused')) } as unknown as Fetcher;

    await expect(new UserVaultClient(binding, undefined).listEnvironmentVariables(USER)).rejects.toMatchObject({
      status: 0,
      code: null,
      message: 'User vault could not be reached',
    });
  });

  it('throws on an answer of the wrong shape', async () => {
    for (const body of [{ variables: { A: 1 } }, { variables: null }, { other: true }]) {
      const { binding } = createBinding(() => Response.json(body));

      await expect(new UserVaultClient(binding, undefined).resolveEnvironmentVariables(USER)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});
