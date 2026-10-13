import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import { configureVault, uniqueUUID, vaultRequests, workerRequest, WORKER_URL, type VaultAnswer } from './runtime-harness.ts';

// /environment-variables: the cases beyond environment-variables-routes.test.ts.

const NAME_MESSAGE = 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$';
const VALUE_MESSAGE = "Field 'value' must be a string of 4 to 16384 characters";
const SECRET = 'speech-secret-value-0001';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(path: string, user: string, method = 'GET', body?: unknown) {
  const response = await SELF.fetch(await workerRequest(path, {
    method,
    userUUID: user,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) as Record<string, any> };
}

const CREATED = { status: 200, body: { name: 'KEY', created_at: 'c', updated_at: 'u', created: true } };

describe('authentication', () => {
  it('answers 401 to every route for a token that does not verify, and asks the vault nothing', async () => {
    const user = uniqueUUID();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const expired = await signJWT({ sub: user, iat: 1, exp: 2 }, JWT_SECRET);
    const wrongSecret = await signJWT({ sub: user, iat: 1, exp: future }, 'another-secret');
    const notUUID = await signJWT({ sub: 'user-1', iat: 1, exp: future }, JWT_SECRET);

    for (const token of [expired, wrongSecret, notUUID, 'garbage']) {
      for (const [path, method] of [['/environment-variables', 'GET'], ['/environment-variables/KEY', 'PUT'], ['/environment-variables/KEY', 'DELETE']] as const) {
        const response = await SELF.fetch(new Request(`${WORKER_URL}${path}`, {
          method,
          headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
          body: method === 'PUT' ? JSON.stringify({ value: SECRET }) : undefined,
        }));
        expect(response.status, `${method} ${path}`).toBe(401);
        await response.text();
      }
    }
    expect(await vaultRequests(user)).toEqual([]);
  });
});

describe('GET /environment-variables', () => {
  it('lists only the name and the times of what the vault answers', async () => {
    const user = uniqueUUID();
    const variables = [
      { name: 'PUBLISH_TOKEN', created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T01:00:00.000Z' },
      { name: 'SPEECH_API_KEY', created_at: '2026-10-13T00:00:02.000Z', updated_at: '2026-10-13T00:00:02.000Z' },
    ];
    await configureVault(user, { list: { status: 200, body: { variables: variables.map((variable) => ({ ...variable, ciphertext: 'must not pass', value: SECRET })) } } });

    const response = await call('/environment-variables', user);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: variables });
    expect(response.text).not.toContain('must not pass');
    expect(response.text).not.toContain(SECRET);
  });

  it('lists nothing for a user without variables', async () => {
    const user = uniqueUUID();
    await configureVault(user, { list: { status: 200, body: { variables: [] } } });

    expect(await call('/environment-variables', user)).toMatchObject({ status: 200, body: { data: [] } });
  });

  it('asks the vault for the user of the token, and only for that user', async () => {
    const user = uniqueUUID();
    const other = uniqueUUID();
    await configureVault(user, { list: { status: 200, body: { variables: [] } } });

    await call('/environment-variables', user);

    expect((await vaultRequests(user)).map((request) => [request.route, request.body])).toEqual([['list', { userId: user }]]);
    expect(await vaultRequests(other)).toEqual([]);
  });

  it('answers 503 service_unavailable whatever fails at the vault', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { list: answer });
      expect(await call('/environment-variables', user), JSON.stringify(answer)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });
});

describe('PUT /environment-variables/:name', () => {
  it('accepts the names the rule allows, down to one character and up to 64', async () => {
    const user = uniqueUUID();
    await configureVault(user, { put: CREATED });

    for (const name of ['A', '_', '_A', 'A1', 'SPEECH_API_KEY', 'A'.repeat(64)]) {
      expect((await call(`/environment-variables/${name}`, user, 'PUT', { value: 'abcd' })).status, name).toBe(201);
    }
  });

  it('answers 400 for a name that breaks the rule, however it is written, and does not ask the vault', async () => {
    const user = uniqueUUID();
    for (const name of ['lower', '1A', 'A-B', 'A.B', 'A'.repeat(65), 'speech', 'A%20B', '%FF', '%E0%A4%A', 'A%2FB']) {
      const response = await call(`/environment-variables/${name}`, user, 'PUT', { value: SECRET });
      expect(response, name).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: NAME_MESSAGE } });
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 400 for a value that is not a string of 4 to 16384 characters, in every other form too', async () => {
    const user = uniqueUUID();
    for (const value of ['abc', '', 'a'.repeat(16_385), 1234, null, ['abcd'], { value: 'abcd' }, true]) {
      const response = await call('/environment-variables/KEY', user, 'PUT', { value });
      expect(response, JSON.stringify(value)?.slice(0, 20)).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: VALUE_MESSAGE } });
    }
    expect(await call('/environment-variables/KEY', user, 'PUT', {})).toMatchObject({ status: 400, body: { error_description: VALUE_MESSAGE } });
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('counts characters, not bytes, for the length of a value', async () => {
    const user = uniqueUUID();
    await configureVault(user, { put: CREATED });

    expect((await call('/environment-variables/KEY', user, 'PUT', { value: '가나다라' })).status).toBe(201);
    expect((await call('/environment-variables/KEY', user, 'PUT', { value: '가'.repeat(16_384) })).status).toBe(201);
    expect((await call('/environment-variables/KEY', user, 'PUT', { value: '가나다' })).status).toBe(400);
  });

  it('sends the shortest and the longest value to the vault whole', async () => {
    const user = uniqueUUID();
    await configureVault(user, { put: CREATED });

    await call('/environment-variables/KEY', user, 'PUT', { value: 'abcd' });
    await call('/environment-variables/KEY', user, 'PUT', { value: 'a'.repeat(16_384) });

    expect((await vaultRequests(user)).map((request) => String(request.body.value).length)).toEqual([4, 16_384]);
  });

  it('answers 400 for a body that is not JSON or not an object, and does not ask the vault', async () => {
    const user = uniqueUUID();
    for (const body of ['not json', '', '{', '["abcd"]', '"abcd"']) {
      const response = await call('/environment-variables/KEY', user, 'PUT', body);
      expect(response.status, body).toBe(400);
      expect(response.body.error, body).toBe('invalid_request');
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 503 for every other failure of the vault, also when it does not answer JSON', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 502, body: 'bad gateway' },
      { status: 404, body: { error: 'not_found' } },
      { status: 401, body: { error: 'unauthorized' } },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { put: answer });
      const response = await call('/environment-variables/KEY', user, 'PUT', { value: SECRET });
      expect(response, JSON.stringify(answer)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });

  it('never returns or logs the value, not even when the vault echoes it', async () => {
    const user = uniqueUUID();
    const lines: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts);
      });
    }
    const texts: string[] = [];
    for (const answer of [
      CREATED,
      { status: 500, body: { error: `echo ${SECRET}` } },
      { status: 400, body: { error: 'invalid_request', message: SECRET } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { put: answer });
      texts.push((await call('/environment-variables/KEY', user, 'PUT', { value: SECRET })).text);
    }
    texts.push((await call('/environment-variables/KEY', user, 'PUT', { value: 'ab' })).text);
    vi.restoreAllMocks();

    expect(JSON.stringify([texts, lines])).not.toContain(SECRET);
  });
});

describe('DELETE /environment-variables/:name', () => {
  it('asks the vault for the user and the name, and answers deleted: true', async () => {
    const user = uniqueUUID();
    await configureVault(user, { delete: { status: 200, body: { deleted: true } } });

    expect(await call('/environment-variables/KEY', user, 'DELETE')).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await vaultRequests(user)).map((request) => [request.route, request.body])).toEqual([['delete', { userId: user, name: 'KEY' }]]);
  });

  it('answers 400 for a name that breaks the rule and does not ask the vault', async () => {
    const user = uniqueUUID();

    expect(await call('/environment-variables/lower', user, 'DELETE')).toMatchObject({
      status: 400,
      body: { error: 'invalid_request', error_description: NAME_MESSAGE },
    });
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 503 when the vault fails, and 500 when it calls the request invalid', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { delete: answer });
      expect((await call('/environment-variables/KEY', user, 'DELETE')).status, JSON.stringify(answer)).toBe(503);
    }

    await configureVault(user, { delete: { status: 400, body: { error: 'invalid_request' } } });
    expect(await call('/environment-variables/KEY', user, 'DELETE')).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });
});

describe('methods and paths', () => {
  it('answers 405 to the other methods of the collection and of a variable, with what is allowed', async () => {
    const user = uniqueUUID();

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await call('/environment-variables', user, method);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('GET');
    }
    for (const method of ['GET', 'POST', 'PATCH']) {
      const response = await call('/environment-variables/KEY', user, method);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('Allow')).toContain('PUT');
      expect(response.headers.get('Allow')).toContain('DELETE');
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('does not take other paths under the prefix for a variable, and does not ask the vault', async () => {
    const user = uniqueUUID();

    for (const path of ['/environment-variables/KEY/extra', '/environment-variable/KEY', '/environment-variables-extra']) {
      const response = await call(path, user, 'PUT', { value: SECRET });
      expect([400, 404, 405], path).toContain(response.status);
    }
    expect(await vaultRequests(user)).toEqual([]);
  });
});
