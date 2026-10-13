import { describe, it, expect, afterEach, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { configureVault, uniqueUUID, vaultRequests, workerRequest, type VaultAnswer } from './runtime-harness.ts';

const VALUE = 'environment-value-secret-0001';

async function call(path: string, userUUID: string | null, method = 'GET', body?: unknown) {
  const response = await SELF.fetch(await workerRequest(path, {
    method,
    userUUID,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }));
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown>, headers: response.headers };
}

async function vault(user: string, responses: Record<string, VaultAnswer>) {
  await configureVault(user, responses);
}

describe('/environment-variables', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the names of the user by name', async () => {
    const user = uniqueUUID();
    const variables = [
      { name: 'A_KEY', created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z' },
      { name: 'B_KEY', created_at: '2026-10-12T00:00:00.000Z', updated_at: '2026-10-13T00:00:00.000Z' },
    ];
    await vault(user, { list: { status: 200, body: { variables } } });

    const response = await call('/environment-variables', user);

    expect(response).toMatchObject({ status: 200, body: { data: variables } });
    expect(await vaultRequests(user)).toEqual([
      expect.objectContaining({ route: 'list', token: 'test-vault-token', body: { userId: user } }),
    ]);
  });

  it('answers 201 when a variable is created and 200 when it is replaced, without the value', async () => {
    const user = uniqueUUID();
    const stored = { name: 'SPEECH_KEY', created_at: '2026-10-13T00:00:00.000Z', updated_at: '2026-10-13T01:00:00.000Z' };
    await vault(user, { put: { status: 200, body: { ...stored, created: true } } });
    const created = await call('/environment-variables/SPEECH_KEY', user, 'PUT', { value: VALUE });
    await vault(user, { put: { status: 200, body: { ...stored, created: false } } });
    const replaced = await call('/environment-variables/SPEECH_KEY', user, 'PUT', { value: VALUE });

    expect(created.status).toBe(201);
    expect(created.body).toEqual(stored);
    expect(replaced.status).toBe(200);
    expect(replaced.body).toEqual(stored);
    expect(created.text).not.toContain(VALUE);
    expect(replaced.text).not.toContain(VALUE);
    expect((await vaultRequests(user)).map((request) => request.body)).toEqual([
      { userId: user, name: 'SPEECH_KEY', value: VALUE },
      { userId: user, name: 'SPEECH_KEY', value: VALUE },
    ]);
  });

  it('refuses a name outside ^[A-Z_][A-Z0-9_]{0,63}$ with 400 without calling the vault', async () => {
    const user = uniqueUUID();
    for (const name of ['lower', '1START', 'HAS-HYPHEN', `A${'B'.repeat(64)}`, '%41']) {
      for (const method of ['PUT', 'DELETE']) {
        const response = await call(`/environment-variables/${name}`, user, method, { value: VALUE });
        expect(response, `${method} ${name}`).toMatchObject({
          status: 400,
          body: { error: 'invalid_request', error_description: 'Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$' },
        });
      }
    }
    const empty = await call('/environment-variables/', user, 'PUT', { value: VALUE });
    expect(empty.status).toBe(400);
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('refuses a value that is not a string of 4 to 16384 characters with 400', async () => {
    const user = uniqueUUID();
    for (const body of [{ value: 'abc' }, { value: 'v'.repeat(16_385) }, { value: 1234 }, {}, [], 'null']) {
      const response = await call('/environment-variables/KEY', user, 'PUT', body);
      expect(response).toMatchObject({
        status: 400,
        body: { error: 'invalid_request', error_description: "Field 'value' must be a string of 4 to 16384 characters" },
      });
    }
    const notJSON = await call('/environment-variables/KEY', user, 'PUT', 'not json');
    expect(notJSON).toMatchObject({ status: 400, body: { error: 'invalid_request', error_description: 'Request body must be valid JSON' } });
    expect(await vaultRequests(user)).toEqual([]);
  });

  it('accepts values of 4 and 16384 characters', async () => {
    const user = uniqueUUID();
    await vault(user, { put: { status: 200, body: { name: 'KEY', created_at: 'c', updated_at: 'u', created: true } } });

    expect((await call('/environment-variables/KEY', user, 'PUT', { value: 'abcd' })).status).toBe(201);
    expect((await call('/environment-variables/KEY', user, 'PUT', { value: 'v'.repeat(16_384) })).status).toBe(201);
  });

  it('deletes a variable, and answers 404 for one that does not exist', async () => {
    const user = uniqueUUID();
    await vault(user, { delete: { status: 200, body: { deleted: true } } });
    const deleted = await call('/environment-variables/KEY', user, 'DELETE');
    await vault(user, { delete: { status: 200, body: { deleted: false } } });
    const missing = await call('/environment-variables/KEY', user, 'DELETE');

    expect(deleted).toMatchObject({ status: 200, body: { deleted: true } });
    expect(missing).toMatchObject({ status: 404, body: { error: 'not_found', error_description: 'Environment variable not found' } });
  });

  it('answers 409 limit_exceeded when the vault refuses the 101st variable', async () => {
    const user = uniqueUUID();
    await vault(user, { put: { status: 409, body: { error: 'limit_exceeded' } } });

    expect(await call('/environment-variables/KEY', user, 'PUT', { value: VALUE })).toMatchObject({
      status: 409,
      body: { error: 'limit_exceeded', error_description: 'At most 100 environment variables are allowed' },
    });
  });

  it('answers 500 when the vault refuses a request this worker checked (a bug)', async () => {
    const user = uniqueUUID();
    await vault(user, { put: { status: 400, body: { error: 'invalid_request' } } });

    expect(await call('/environment-variables/KEY', user, 'PUT', { value: VALUE })).toMatchObject({ status: 500, body: { error: 'server_error' } });
  });

  it('answers 503 for any other vault failure', async () => {
    const user = uniqueUUID();
    for (const answer of [
      { status: 401, body: { error: 'unauthorized' } },
      { status: 404, body: { error: 'not_found' } },
      { status: 503, body: { error: 'vault_unavailable' } },
      { status: 500, body: { error: 'server_error' } },
      { status: 'unreachable' as const },
    ]) {
      await vault(user, { list: answer, put: answer, delete: answer });
      for (const [path, method, body] of [
        ['/environment-variables', 'GET', undefined],
        ['/environment-variables/KEY', 'PUT', { value: VALUE }],
        ['/environment-variables/KEY', 'DELETE', undefined],
      ] as const) {
        const response = await call(path, user, method, body);
        expect(response, `${String(answer.status)} ${method}`).toMatchObject({ status: 503, body: { error: 'service_unavailable' } });
        expect(response.text).not.toContain(VALUE);
      }
    }
  });

  it('never puts the value in a response or a log line', async () => {
    const lines: unknown[][] = [];
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        lines.push(parts);
      });
    }
    const user = uniqueUUID();
    const texts: string[] = [];
    for (const answer of [
      { status: 200, body: { name: 'KEY', created_at: 'c', updated_at: 'u', created: true } },
      { status: 409, body: { error: 'limit_exceeded' } },
      { status: 400, body: { error: 'invalid_request' } },
      { status: 503, body: { error: 'vault_unavailable' } },
    ]) {
      await vault(user, { put: answer });
      texts.push((await call('/environment-variables/KEY', user, 'PUT', { value: VALUE })).text);
    }
    texts.push((await call('/environment-variables/lower', user, 'PUT', { value: VALUE })).text);

    expect(JSON.stringify([texts, lines])).not.toContain(VALUE);
  });

  it('answers 401 without authentication and 405 for another method', async () => {
    expect((await call('/environment-variables', null)).status).toBe(401);
    expect((await call('/environment-variables/KEY', null, 'PUT', { value: VALUE })).status).toBe(401);

    const user = uniqueUUID();
    const postList = await call('/environment-variables', user, 'POST');
    const getOne = await call('/environment-variables/KEY', user, 'GET');
    expect(postList.status).toBe(405);
    expect(postList.headers.get('Allow')).toBe('GET');
    expect(getOne.status).toBe(405);
    expect(getOne.headers.get('Allow')).toBe('PUT, DELETE');
  });
});
