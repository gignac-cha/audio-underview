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
