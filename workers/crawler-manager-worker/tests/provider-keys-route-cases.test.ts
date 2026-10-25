import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { signJWT } from '@audio-underview/worker-tools';
import { configureVault, uniqueUUID, vaultRequests, workerRequest, WORKER_URL, type VaultAnswer } from './runtime-harness.ts';

// /provider-keys: the cases beyond provider-keys-routes.test.ts.

const KEY_MESSAGE = "Field 'key' must be 16 to 512 printable characters without spaces";
const SECRET = 'provider-secret-value-0001-xyz';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai'] as const;

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

const STORED = { status: 200, body: { provider: 'google', configured: true, last4: 'z_01', validatedAt: '2026-10-26T00:00:00.000Z' } };

describe('authentication', () => {
  it('answers 401 to every route for a token that does not verify, and asks the vault nothing', async () => {
    const user = uniqueUUID();
    const future = Math.floor(Date.now() / 1000) + 3600;
    const expired = await signJWT({ sub: user, iat: 1, exp: 2 }, JWT_SECRET);
    const wrongSecret = await signJWT({ sub: user, iat: 1, exp: future }, 'another-secret');
    const notUUID = await signJWT({ sub: 'user-1', iat: 1, exp: future }, JWT_SECRET);

    for (const token of [expired, wrongSecret, notUUID, 'garbage']) {
      for (const [path, method] of [
        ['/provider-keys', 'GET'],
        ['/provider-keys/audit', 'GET'],
        ['/provider-keys/google', 'PUT'],
        ['/provider-keys/google', 'DELETE'],
      ] as const) {
        const response = await SELF.fetch(new Request(`${WORKER_URL}${path}`, {
          method,
          headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
          body: method === 'PUT' ? JSON.stringify({ key: SECRET }) : undefined,
        }));
        expect(response.status, `${method} ${path}`).toBe(401);
        await response.text();
      }
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 401 before it looks at the method, the provider or the body', async () => {
    for (const [path, method] of [['/provider-keys', 'POST'], ['/provider-keys/mistral', 'PUT'], ['/provider-keys/audit', 'DELETE']] as const) {
      const response = await SELF.fetch(await workerRequest(path, { method, userUUID: null, body: method === 'PUT' ? 'not json' : undefined }));
      expect(response.status, `${method} ${path}`).toBe(401);
      await response.text();
    }
  });
});

describe('GET /provider-keys', () => {
  it('lists only provider, configured, last4 and validated_at of what the vault answers', async () => {
    const user = uniqueUUID();
    const keys = PROVIDERS.map((provider, index) => (index % 2 === 0
      ? { provider, configured: true, last4: `000${index}`, validatedAt: '2026-10-26T00:00:00.000Z' }
      : { provider, configured: false, last4: null, validatedAt: null }));
    await configureVault(user, {
      'keys/status': {
        status: 200,
        body: { keys: keys.map((entry) => ({ ...entry, ciphertext: 'must not pass', key: SECRET, wrappedDataEncryptionKey: 'must not pass either' })) },
      },
    });

    const response = await call('/provider-keys', user);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: keys.map(({ provider, configured, last4, validatedAt }) => ({ provider, configured, last4, validated_at: validatedAt })),
    });
    expect(response.text).not.toContain('must not pass');
    expect(response.text).not.toContain(SECRET);
  });

  it('answers 503 for an answer of the vault that is not the shape it should have', async () => {
    const user = uniqueUUID();
    for (const body of [
      {},
      { keys: 'none' },
      { keys: [{ provider: 'mistral', configured: false, last4: null, validatedAt: null }] },
      { keys: [{ provider: 'google', configured: 'yes', last4: null, validatedAt: null }] },
      { keys: [{ provider: 'google', configured: true, last4: 1234, validatedAt: null }] },
      { keys: [{ provider: 'google', configured: true, last4: '1234', validatedAt: 20261026 }] },
      { keys: [null] },
    ]) {
      await configureVault(user, { 'keys/status': { status: 200, body } });

      expect(await call('/provider-keys', user), JSON.stringify(body)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });

  it('answers 503 when the vault answers 200 without JSON', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/status': { status: 200, body: 'ok' } });

    expect(await call('/provider-keys', user)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
  });

  it('answers 500 when the vault calls the request invalid, which it never does for a user it was given', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/status': { status: 400, body: { error: 'invalid_request' } } });

    expect(await call('/provider-keys', user)).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });
});

describe('GET /provider-keys/audit', () => {
  it('lists provider, action and at of every event, in the order of the vault, and nothing else', async () => {
    const user = uniqueUUID();
    const events = [
      { provider: 'anthropic', action: 'registered', at: '2026-10-26T00:00:03.000Z' },
      { provider: 'openai', action: 'replaced', at: '2026-10-26T00:00:02.000Z' },
      { provider: 'google', action: 'removed', at: '2026-10-26T00:00:01.000Z' },
      { provider: 'xai', action: 'used', at: '2026-10-26T00:00:00.000Z' },
    ];
    await configureVault(user, {
      'keys/audit': { status: 200, body: { events: events.map((event) => ({ ...event, ipHash: 'must not pass', userAgentHash: 'must not pass' })) } },
    });

    const response = await call('/provider-keys/audit', user);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: events });
    expect(response.text).not.toContain('must not pass');
  });

  it('lists nothing for a user without events', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/audit': { status: 200, body: { events: [] } } });

    expect(await call('/provider-keys/audit', user)).toMatchObject({ status: 200, body: { data: [] } });
  });

  it('answers 503 for an event of a shape it should not have', async () => {
    const user = uniqueUUID();
    for (const body of [
      {},
      { events: 'none' },
      { events: [{ provider: 'mistral', action: 'used', at: 'a' }] },
      { events: [{ provider: 'google', action: 'rotated', at: 'a' }] },
      { events: [{ provider: 'google', action: 'used', at: 1 }] },
      { events: [{ provider: 'google', action: 'used' }] },
    ]) {
      await configureVault(user, { 'keys/audit': { status: 200, body } });

      expect(await call('/provider-keys/audit', user), JSON.stringify(body)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });

  it('answers 503 whatever fails at the vault', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { 'keys/audit': answer });
      expect(await call('/provider-keys/audit', user), JSON.stringify(answer)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });
});

describe('PUT /provider-keys/:provider', () => {
  it('accepts every one of the four providers', async () => {
    const user = uniqueUUID();
    for (const provider of PROVIDERS) {
      await configureVault(user, { 'keys/put': { status: 200, body: { ...STORED.body, provider } } });

      expect(await call(`/provider-keys/${provider}`, user, 'PUT', { key: SECRET }), provider).toMatchObject({
        status: 200,
        body: { provider, configured: true },
      });
    }
    expect((await vaultRequests(user)).map((request) => request.body.provider)).toEqual([...PROVIDERS]);
  });

  it('accepts keys of 16 and 512 characters and of the first and the last printable character', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/put': STORED });

    for (const key of ['k'.repeat(16), 'k'.repeat(512), '!'.repeat(16), '~'.repeat(16), '!~'.repeat(256)]) {
      expect((await call('/provider-keys/google', user, 'PUT', { key })).status, key.slice(0, 20)).toBe(200);
    }
    expect((await vaultRequests(user)).map((request) => String(request.body.key).length)).toEqual([16, 512, 16, 16, 512]);
  });

  it('answers 400 for a key of 15 or 513 characters, or with a space, a control or a non-ASCII character in it', async () => {
    const user = uniqueUUID();
    const keys = [
      'k'.repeat(15),
      'k'.repeat(513),
      '',
      `${'k'.repeat(15)} `,
      `${'k'.repeat(8)} ${'k'.repeat(8)}`,
      `${'k'.repeat(16)}\n`,
      `${'k'.repeat(16)}\t`,
      `${'k'.repeat(16)}\u007f`,
      `${'k'.repeat(16)}\u0000`,
      `${'k'.repeat(16)}가`,
      `${'k'.repeat(16)} `,
      '가'.repeat(16),
      '😀'.repeat(8),
    ];
    for (const key of keys) {
      const response = await call('/provider-keys/google', user, 'PUT', { key });
      expect(response, JSON.stringify(key)).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: KEY_MESSAGE } });
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 400 for a key that is not a string, in every other form too', async () => {
    const user = uniqueUUID();
    for (const key of [null, 1234567890123456, true, [SECRET], { key: SECRET }]) {
      const response = await call('/provider-keys/google', user, 'PUT', { key });
      expect(response, JSON.stringify(key)?.slice(0, 20)).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: KEY_MESSAGE } });
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 400 for a body that is not JSON or not an object, and does not call the vault', async () => {
    const user = uniqueUUID();
    for (const body of ['not json', '', '{', `["${SECRET}"]`, `"${SECRET}"`]) {
      const response = await call('/provider-keys/google', user, 'PUT', body);
      expect(response.status, body).toBe(400);
      expect(response.body.error, body).toBe('invalid_request');
      expect(response.text, body).not.toContain(SECRET);
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 404 for an unknown provider before it reads the body', async () => {
    const user = uniqueUUID();

    for (const provider of ['mistral', 'Anthropic', 'GOOGLE', '%67oogle', 'google%20', 'constructor', '__proto__', '']) {
      const response = await call(`/provider-keys/${provider}`, user, 'PUT', 'not json');
      expect(response, provider).toMatchObject({ status: 404, body: { error: 'not_found', error_description: 'Unknown provider' } });
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('sends the vault the key whole, and only the fields it takes', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/put': STORED });

    await call('/provider-keys/google', user, 'PUT', { key: SECRET, provider: 'openai', userId: uniqueUUID(), ip: '198.51.100.1', extra: true });

    const [request] = await vaultRequests(user);
    expect(request.route).toBe('keys/put');
    expect(request.method).toBe('POST');
    expect(request.body).toMatchObject({ userId: user, provider: 'google', key: SECRET });
    expect(request.body).not.toHaveProperty('extra');
    expect(request.body.ip).not.toBe('198.51.100.1');
  });

  it('answers 503 for a stored answer that is not the shape it should have, and for one that says the key is not set', async () => {
    const user = uniqueUUID();
    for (const body of [
      {},
      { provider: 'google', configured: false, last4: null, validatedAt: null },
      { provider: 'mistral', configured: true, last4: 'z_01', validatedAt: 'v' },
      { provider: 'google', configured: true, last4: 1, validatedAt: 'v' },
      { provider: 'google', configured: true, last4: 'z_01', validatedAt: 1 },
    ]) {
      await configureVault(user, { 'keys/put': { status: 200, body } });

      const response = await call('/provider-keys/google', user, 'PUT', { key: SECRET });
      expect(response, JSON.stringify(body)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
      expect(response.text).not.toContain(SECRET);
    }
  });

  it('maps a 400 by its code, and a 503 by its code, nothing else', async () => {
    const user = uniqueUUID();
    const cases: [VaultAnswer, number, string][] = [
      [{ status: 400, body: { error: 'invalid_key' } }, 400, 'invalid_key'],
      [{ status: 503, body: { error: 'validation_unavailable' } }, 503, 'validation_unavailable'],
      [{ status: 400, body: { error: 'unknown_provider' } }, 500, 'server_error'],
      [{ status: 400, body: { error: 'invalid_request' } }, 500, 'server_error'],
      [{ status: 400, body: {} }, 500, 'server_error'],
      [{ status: 400, body: 'bad request' }, 500, 'server_error'],
      [{ status: 503, body: { error: 'vault_unavailable' } }, 503, 'service_unavailable'],
      [{ status: 503, body: {} }, 503, 'service_unavailable'],
      [{ status: 401, body: { error: 'invalid_key' } }, 503, 'service_unavailable'],
      [{ status: 404, body: { error: 'invalid_key' } }, 503, 'service_unavailable'],
      [{ status: 500, body: { error: 'validation_unavailable' } }, 503, 'service_unavailable'],
      [{ status: 502, body: 'bad gateway' }, 503, 'service_unavailable'],
      [{ status: 409, body: { error: 'conflict' } }, 503, 'service_unavailable'],
      [{ status: 'unreachable' }, 503, 'service_unavailable'],
    ];
    for (const [answer, status, error] of cases) {
      await configureVault(user, { 'keys/put': answer });

      const response = await call('/provider-keys/openai', user, 'PUT', { key: SECRET });
      expect(response, JSON.stringify(answer)).toMatchObject({ status, body: { error } });
      expect(response.text).not.toContain(SECRET);
    }
  });

  it('never returns or logs the key, not even when the vault echoes it', async () => {
    const user = uniqueUUID();
    const lines: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts);
      });
    }
    const texts: string[] = [];
    for (const answer of [
      STORED,
      { status: 500, body: { error: `echo ${SECRET}` } },
      { status: 400, body: { error: 'invalid_key', message: SECRET } },
      { status: 503, body: { error: 'validation_unavailable', message: SECRET } },
      { status: 200, body: { provider: 'google', configured: true, last4: 'z_01', validatedAt: 'v', key: SECRET } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { 'keys/put': answer });
      texts.push((await call('/provider-keys/google', user, 'PUT', { key: SECRET })).text);
    }
    texts.push((await call('/provider-keys/google', user, 'PUT', { key: 'ab' })).text);
    texts.push((await call('/provider-keys/mistral', user, 'PUT', { key: SECRET })).text);
    vi.restoreAllMocks();

    expect(JSON.stringify([texts, lines])).not.toContain(SECRET);
  });
});

describe('DELETE /provider-keys/:provider', () => {
  it('asks the vault for the user and the provider, and answers deleted: true', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/delete': { status: 200, body: { removed: true } } });

    expect(await call('/provider-keys/xai', user, 'DELETE')).toMatchObject({ status: 200, body: { deleted: true } });
    expect((await vaultRequests(user)).map((request) => [request.route, request.body])).toEqual([['keys/delete', { userId: user, provider: 'xai' }]]);
  });

  it('answers 404 for an unknown provider and does not ask the vault', async () => {
    const user = uniqueUUID();

    for (const provider of ['mistral', 'Google', 'google%2Fx', '']) {
      expect(await call(`/provider-keys/${provider}`, user, 'DELETE'), provider).toMatchObject({
        status: 404,
        body: { error: 'not_found', error_description: 'Unknown provider' },
      });
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 503 when the vault fails, and 500 when it calls the request invalid', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 401, body: { error: 'unauthorized' } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { 'keys/delete': answer });
      expect((await call('/provider-keys/google', user, 'DELETE')).status, JSON.stringify(answer)).toBe(503);
    }

    await configureVault(user, { 'keys/delete': { status: 400, body: { error: 'unknown_provider' } } });
    expect(await call('/provider-keys/google', user, 'DELETE')).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });

  it('does not map invalid_key, which a delete never answers, to anything but a bug', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/delete': { status: 400, body: { error: 'invalid_key' } } });

    expect(await call('/provider-keys/google', user, 'DELETE')).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });

  it('answers 503 for an answer without removed as a boolean', async () => {
    const user = uniqueUUID();
    for (const body of [{}, { removed: 'yes' }, { deleted: true }]) {
      await configureVault(user, { 'keys/delete': { status: 200, body } });

      expect(await call('/provider-keys/google', user, 'DELETE'), JSON.stringify(body)).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
    }
  });
});

describe('methods and paths', () => {
  it('answers 405 to the other methods of the list, the history and a provider, with what is allowed', async () => {
    const user = uniqueUUID();

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const list = await call('/provider-keys', user, method);
      expect(list.status, `list ${method}`).toBe(405);
      expect(list.headers.get('Allow')).toBe('GET');
      const audit = await call('/provider-keys/audit', user, method);
      expect(audit.status, `audit ${method}`).toBe(405);
      expect(audit.headers.get('Allow')).toBe('GET');
    }
    for (const method of ['GET', 'POST', 'PATCH']) {
      const response = await call('/provider-keys/google', user, method);
      expect(response.status, `provider ${method}`).toBe(405);
      expect(response.headers.get('Allow')).toBe('PUT, DELETE');
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 405 for a method the route does not take before it checks the provider', async () => {
    const user = uniqueUUID();

    expect((await call('/provider-keys/mistral', user, 'GET')).status).toBe(405);
    expect((await call('/provider-keys/mistral', user, 'POST')).status).toBe(405);
  });

  it('does not take other paths under the prefix for a provider, and does not ask the vault', async () => {
    const user = uniqueUUID();

    for (const path of ['/provider-keys/google/extra', '/provider-key/google', '/provider-keys-extra', '/provider-keys/audit/extra']) {
      const response = await call(path, user, 'PUT', { key: SECRET });
      expect([404, 405], path).toContain(response.status);
    }
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('lists the four routes in the help', async () => {
    const response = await SELF.fetch(new Request(`${WORKER_URL}/`, { headers: { Origin: 'https://example.com' } }));
    const help = await response.json() as { endpoints: { method: string; path: string }[] };

    expect(help.endpoints.filter((endpoint) => endpoint.path.startsWith('/provider-keys')).map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'GET /provider-keys',
      'GET /provider-keys/audit',
      'PUT /provider-keys/:provider',
      'DELETE /provider-keys/:provider',
    ]);
  });
});
