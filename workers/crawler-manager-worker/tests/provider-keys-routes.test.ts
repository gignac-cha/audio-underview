import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { configureVault, uniqueUUID, vaultRequests, workerRequest, type VaultAnswer } from './runtime-harness.ts';

const KEY = 'provider-key-secret-value-0001';
const PROVIDERS = ['anthropic', 'openai', 'google', 'xai'] as const;

async function call(path: string, userUUID: string | null, method = 'GET', body?: unknown, headers?: Record<string, string>) {
  const response = await SELF.fetch(await workerRequest(path, {
    method,
    userUUID,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown>, headers: response.headers };
}

function vaultStatus(configuredProviders: readonly string[] = []) {
  return {
    keys: PROVIDERS.map((provider) => configuredProviders.includes(provider)
      ? { provider, configured: true, last4: '0001', validatedAt: '2026-10-26T00:00:00.000Z' }
      : { provider, configured: false, last4: null, validatedAt: null }),
  };
}

describe('/provider-keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the four providers in the order of the vault, with validated_at', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/status': { status: 200, body: vaultStatus(['openai', 'xai']) } });

    const response = await call('/provider-keys', user);

    expect(response).toMatchObject({
      status: 200,
      body: {
        data: [
          { provider: 'anthropic', configured: false, last4: null, validated_at: null },
          { provider: 'openai', configured: true, last4: '0001', validated_at: '2026-10-26T00:00:00.000Z' },
          { provider: 'google', configured: false, last4: null, validated_at: null },
          { provider: 'xai', configured: true, last4: '0001', validated_at: '2026-10-26T00:00:00.000Z' },
        ],
      },
    });
    expect(await vaultRequests(user)).toEqual([
      expect.objectContaining({ route: 'keys/status', token: 'test-vault-token', body: { userId: user } }),
    ]);
  });

  it('lists the 50 newest events, newest first', async () => {
    const user = uniqueUUID();
    const events = [
      { provider: 'google', action: 'used', at: '2026-10-26T02:00:00.000Z' },
      { provider: 'google', action: 'replaced', at: '2026-10-26T01:00:00.000Z' },
      { provider: 'google', action: 'registered', at: '2026-10-26T00:00:00.000Z' },
      { provider: 'xai', action: 'removed', at: '2026-10-25T00:00:00.000Z' },
    ];
    await configureVault(user, { 'keys/audit': { status: 200, body: { events } } });

    const response = await call('/provider-keys/audit', user);

    expect(response).toMatchObject({ status: 200, body: { data: events } });
    expect(await vaultRequests(user)).toEqual([
      expect.objectContaining({ route: 'keys/audit', token: 'test-vault-token', body: { userId: user, limit: 50 } }),
    ]);
  });

  it('registers a key and answers its last four characters and when it was checked, without the key', async () => {
    const user = uniqueUUID();
    await configureVault(user, {
      'keys/put': { status: 200, body: { provider: 'google', configured: true, last4: '0001', validatedAt: '2026-10-26T03:00:00.000Z' } },
    });

    const response = await call('/provider-keys/google', user, 'PUT', { key: KEY });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ provider: 'google', configured: true, last4: '0001', validated_at: '2026-10-26T03:00:00.000Z' });
    expect(response.text).not.toContain(KEY);
    expect(await vaultRequests(user)).toEqual([
      expect.objectContaining({
        route: 'keys/put',
        token: 'test-vault-token',
        body: expect.objectContaining({ userId: user, provider: 'google', key: KEY }),
      }),
    ]);
  });

  it('deletes a key, and answers 404 for one that is not there', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/delete': { status: 200, body: { removed: true } } });
    const deleted = await call('/provider-keys/openai', user, 'DELETE');
    await configureVault(user, { 'keys/delete': { status: 200, body: { removed: false } } });
    const missing = await call('/provider-keys/openai', user, 'DELETE');

    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } });
    expect(missing).toMatchObject({ status: 404, body: { error: 'not_found', error_description: 'Provider key not found' } });
    expect((await vaultRequests(user)).map((request) => [request.route, request.body])).toEqual([
      ['keys/delete', expect.objectContaining({ userId: user, provider: 'openai' })],
      ['keys/delete', expect.objectContaining({ userId: user, provider: 'openai' })],
    ]);
  });

  it('answers 404 for a provider that is none of the four, and does not call the vault', async () => {
    const user = uniqueUUID();
    for (const method of ['PUT', 'DELETE']) {
      const response = await call('/provider-keys/mistral', user, method, { key: KEY });
      expect(response, method).toMatchObject({ status: 404, body: { error: 'not_found', error_description: 'Unknown provider' } });
    }

    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 400 for a key that is not 16 to 512 printable characters without spaces, and does not call the vault', async () => {
    const user = uniqueUUID();
    for (const body of [{ key: 'short-key' }, { key: 'k'.repeat(513) }, { key: 'has a space in the key' }, { key: 1234 }, {}, [], 'null']) {
      const response = await call('/provider-keys/anthropic', user, 'PUT', body);
      expect(response, JSON.stringify(body).slice(0, 30)).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', error_description: "Field 'key' must be 16 to 512 printable characters without spaces" },
      });
    }
    const notJSON = await call('/provider-keys/anthropic', user, 'PUT', 'not json');
    expect(notJSON).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: 'Request body must be valid JSON' } });

    expect(await vaultRequests(user)).toEqual([]);
  });

  it('answers 400 invalid_key and 503 validation_unavailable as the vault does for a key it checked', async () => {
    const user = uniqueUUID();
    await configureVault(user, { 'keys/put': { status: 400, body: { error: 'invalid_key' } } });
    const invalid = await call('/provider-keys/xai', user, 'PUT', { key: KEY });
    await configureVault(user, { 'keys/put': { status: 503, body: { error: 'validation_unavailable' } } });
    const unavailable = await call('/provider-keys/xai', user, 'PUT', { key: KEY });

    expect(invalid).toMatchObject({
      status: 400,
      body: { error: 'invalid_key', error_description: 'The provider did not accept this key' },
    });
    expect(unavailable).toMatchObject({
      status: 503,
      body: {
        error: 'validation_unavailable',
        error_description: 'The provider could not be reached to check the key. Try again later',
      },
    });
  });

  it('answers 500 when the vault refuses another way a key this worker checked (a bug)', async () => {
    const user = uniqueUUID();
    for (const error of ['unknown_provider', 'invalid_request']) {
      await configureVault(user, { 'keys/put': { status: 400, body: { error } } });

      expect(await call('/provider-keys/google', user, 'PUT', { key: KEY }), error).toMatchObject({
        status: 500,
        body: { error: 'server_error' },
      });
    }
  });

  it('answers 503 service_unavailable for any other vault failure', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 401, body: { error: 'unauthorized' } },
      { status: 404, body: { error: 'not_found' } },
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 'unreachable' as const },
    ] satisfies VaultAnswer[]) {
      await configureVault(user, { 'keys/status': answer, 'keys/audit': answer, 'keys/put': answer, 'keys/delete': answer });
      for (const [path, method, body] of [
        ['/provider-keys', 'GET', undefined],
        ['/provider-keys/audit', 'GET', undefined],
        ['/provider-keys/google', 'PUT', { key: KEY }],
        ['/provider-keys/google', 'DELETE', undefined],
      ] as const) {
        const response = await call(path, user, method, body);
        expect(response, `${String(answer.status)} ${method} ${path}`).toMatchObject({
          status: 503,
          body: { error: 'service_unavailable', error_description: 'Provider keys are not available right now' },
        });
        expect(response.text).not.toContain(KEY);
      }
    }
  });

  it('never puts the key in a response or a log line', async () => {
    const lines: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts);
      });
    }
    const user = uniqueUUID();
    const texts: string[] = [];
    for (const answer of [
      { status: 200, body: { provider: 'google', configured: true, last4: '0001', validatedAt: 'v' } },
      { status: 400, body: { error: 'invalid_key' } },
      { status: 503, body: { error: 'validation_unavailable' } },
      { status: 400, body: { error: 'unknown_provider' } },
      { status: 503, body: { error: 'vault_unavailable' } },
    ]) {
      await configureVault(user, { 'keys/put': answer });
      texts.push((await call('/provider-keys/google', user, 'PUT', { key: KEY })).text);
    }
    texts.push((await call('/provider-keys/mistral', user, 'PUT', { key: KEY })).text);
    texts.push((await call('/provider-keys/google', user, 'PUT', { key: `${KEY} with a space` })).text);
    vi.restoreAllMocks();

    expect(JSON.stringify([texts, lines])).not.toContain(KEY);
  });

  it('answers 401 without authentication and 405 for another method', async () => {
    expect((await call('/provider-keys', null)).status).toBe(401);
    expect((await call('/provider-keys/audit', null)).status).toBe(401);
    expect((await call('/provider-keys/google', null, 'PUT', { key: KEY })).status).toBe(401);
    expect((await call('/provider-keys/google', null, 'DELETE')).status).toBe(401);

    const user = uniqueUUID();
    const postList = await call('/provider-keys', user, 'POST');
    const putAudit = await call('/provider-keys/audit', user, 'PUT', { key: KEY });
    const getOne = await call('/provider-keys/google', user, 'GET');
    expect(postList.status).toBe(405);
    expect(postList.headers.get('Allow')).toBe('GET');
    expect(putAudit.status).toBe(405);
    expect(putAudit.headers.get('Allow')).toBe('GET');
    expect(getOne.status).toBe(405);
    expect(getOne.headers.get('Allow')).toBe('PUT, DELETE');
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('passes the address and the user agent of the client to the vault, and leaves out what the request lacks', async () => {
    const user = uniqueUUID();
    await configureVault(user, {
      'keys/put': { status: 200, body: { provider: 'google', configured: true, last4: '0001', validatedAt: 'v' } },
      'keys/delete': { status: 200, body: { removed: true } },
    });

    await call('/provider-keys/google', user, 'PUT', { key: KEY }, { 'CF-Connecting-IP': '203.0.113.7', 'User-Agent': 'Mozilla/5.0 test' });
    await call('/provider-keys/google', user, 'DELETE', undefined, { 'CF-Connecting-IP': '203.0.113.8', 'User-Agent': 'Mozilla/5.0 other' });
    await call('/provider-keys/google', user, 'PUT', { key: KEY }, { 'CF-Connecting-IP': '203.0.113.9' });

    const [put, remove, putWithoutAgent] = (await vaultRequests(user)).map((request) => request.body);
    expect(put).toEqual({ userId: user, provider: 'google', key: KEY, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test' });
    expect(remove).toEqual({ userId: user, provider: 'google', ip: '203.0.113.8', userAgent: 'Mozilla/5.0 other' });
    expect(putWithoutAgent).toMatchObject({ ip: '203.0.113.9' });
    expect(putWithoutAgent).not.toHaveProperty('userAgent');
  });

  it('keeps the users apart', async () => {
    const user = uniqueUUID();
    const other = uniqueUUID();
    await configureVault(user, { 'keys/status': { status: 200, body: vaultStatus(['google']) } });
    await configureVault(other, { 'keys/status': { status: 200, body: vaultStatus(['anthropic']) } });

    const mine = await call('/provider-keys', user);
    const theirs = await call('/provider-keys', other);

    expect((mine.body.data as { provider: string; configured: boolean }[]).filter((entry) => entry.configured).map((entry) => entry.provider)).toEqual(['google']);
    expect((theirs.body.data as { provider: string; configured: boolean }[]).filter((entry) => entry.configured).map((entry) => entry.provider)).toEqual(['anthropic']);
    expect((await vaultRequests(user)).map((request) => request.body)).toEqual([{ userId: user }]);
    expect((await vaultRequests(other)).map((request) => request.body)).toEqual([{ userId: other }]);
  });
});
