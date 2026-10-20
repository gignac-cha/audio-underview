import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase, SUPABASE_ENVIRONMENT, type InMemoryEnvironmentVariableRow } from '../tests/in-memory-supabase.ts';
import { openProviderKey, sealProviderKey } from './envelope.ts';
import type { Environment } from './environment.ts';
import worker from './index.ts';

// The environment variable routes: the cases beyond environment-variables.test.ts.

const WORKER_ORIGIN = 'https://user-vault.internal';
const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';
const CURRENT_SECRET = 'current-key-encryption-secret';
const PREVIOUS_SECRET = 'previous-key-encryption-secret';

const VALUES = {
  SPEECH_API_KEY: 'speech-api-secret-value-0001',
  PUBLISH_TOKEN: 'publish-token-secret-0002',
  OTHER_USER_VALUE: 'other-user-secret-value-0003',
};

// The database can change under a route between two of its requests (beforeRequest), as a concurrent writer would
let database: InMemorySupabase;
let environment: Environment;
let logLines: string[];
let responseTexts: string[];

function createEnvironment(overrides: Partial<Environment> = {}): Environment {
  return { ...SUPABASE_ENVIRONMENT, PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_VERSION: '1', ...overrides };
}

beforeEach(() => {
  database = new InMemorySupabase();
  environment = createEnvironment();
  logLines = [];
  responseTexts = [];
  for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    });
  }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (database.serves(input)) {
      return database.fetch(input, init);
    }
    throw new Error('The environment variable routes must not make any request beyond Supabase');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function post(path: string, body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await worker.fetch(new Request(`${WORKER_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), environment);
  const text = await response.text();
  responseTexts.push(text);
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

function call(path: string, body: unknown) {
  return post(path, JSON.stringify(body));
}

function put(userID: string, name: string, value: string) {
  return call('/internal/environment-variables/put', { userId: userID, name, value });
}

function list(userID: string) {
  return call('/internal/environment-variables/list', { userId: userID });
}

function resolve(userID: string) {
  return call('/internal/environment-variables/resolve', { userId: userID });
}

function remove(userID: string, name: string) {
  return call('/internal/environment-variables/delete', { userId: userID, name });
}

function rowFor(userID: string, name: string): InMemoryEnvironmentVariableRow | undefined {
  return database.environmentVariables.find((row) => row.user_id === userID && row.name === name);
}

function openRow(row: InMemoryEnvironmentVariableRow, userID: string, secrets: string[]) {
  return openProviderKey({
    userID,
    envelope: {
      provider: `environment-variable:${row.name}`,
      ciphertext: row.ciphertext,
      initializationVector: row.iv,
      wrappedDataEncryptionKey: row.wrapped_dek,
      dataEncryptionKeyInitializationVector: row.dek_iv,
      keyVersion: row.key_version,
      createdAt: row.updated_at,
    },
    keyEncryptionKeySecrets: secrets,
  });
}

function fillTo(userID: string, count: number): void {
  for (let index = database.environmentVariables.filter((row) => row.user_id === userID).length; index < count; index += 1) {
    database.environmentVariables.push({
      user_id: userID,
      name: `FILLER_${String(index).padStart(3, '0')}`,
      ciphertext: 'Y2lwaGVydGV4dA==',
      iv: 'aXY=',
      wrapped_dek: `d3JhcHBlZA==${index}`,
      dek_iv: 'ZGVrLWl2',
      key_version: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    });
  }
}

function concurrentRow(userID: string, name: string): InMemoryEnvironmentVariableRow {
  return {
    user_id: userID,
    name,
    ciphertext: 'Y29uY3VycmVudA==',
    iv: 'aXY=',
    wrapped_dek: 'd3JhcHBlZA==',
    dek_iv: 'ZGVrLWl2',
    key_version: 1,
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z',
  };
}

function expectNoValue(texts: string[]) {
  for (const text of texts) {
    for (const value of Object.values(VALUES)) {
      expect(text).not.toContain(value);
    }
  }
}

describe('put', () => {
  it('keeps users apart: the same name of two users is two rows with two values', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await expect(put(USER_2, 'SPEECH_API_KEY', VALUES.OTHER_USER_VALUE)).resolves.toMatchObject({ status: 200, json: { created: true } });

    expect(database.environmentVariables).toHaveLength(2);
    await expect(resolve(USER_1)).resolves.toMatchObject({ json: { variables: { SPEECH_API_KEY: VALUES.SPEECH_API_KEY } } });
    await expect(resolve(USER_2)).resolves.toMatchObject({ json: { variables: { SPEECH_API_KEY: VALUES.OTHER_USER_VALUE } } });
  });

  it('answers 409 limit_exceeded for a new name at the limit and still replaces an existing name', async () => {
    fillTo(USER_1, 100);

    await expect(put(USER_1, 'ONE_TOO_MANY', VALUES.SPEECH_API_KEY)).resolves.toEqual({ status: 409, json: { error: 'limit_exceeded' } });
    expect(rowFor(USER_1, 'ONE_TOO_MANY')).toBeUndefined();
    await expect(put(USER_1, 'FILLER_007', VALUES.PUBLISH_TOKEN)).resolves.toMatchObject({ status: 200, json: { created: false } });
    expect(database.environmentVariables.filter((row) => row.user_id === USER_1)).toHaveLength(100);
  });

  it('does not stop a user below the limit because another user is at it', async () => {
    fillTo(USER_1, 100);

    await expect(put(USER_2, 'SPEECH_API_KEY', VALUES.OTHER_USER_VALUE)).resolves.toMatchObject({ status: 200, json: { created: true } });
  });

  it('frees a place under the limit when a variable is deleted', async () => {
    fillTo(USER_1, 100);
    await expect(put(USER_1, 'NEW_NAME', VALUES.SPEECH_API_KEY)).resolves.toMatchObject({ status: 409 });

    await remove(USER_1, 'FILLER_000');

    await expect(put(USER_1, 'NEW_NAME', VALUES.SPEECH_API_KEY)).resolves.toMatchObject({ status: 200, json: { created: true } });
  });

  it('replaces the name a concurrent put added between the replace and the insert', async () => {
    let raced = false;
    database.beforeRequest = (request) => {
      if (!raced && request.table === 'rpc/insert_environment_variable') {
        raced = true;
        database.environmentVariables.push(concurrentRow(USER_1, 'SPEECH_API_KEY'));
      }
    };

    const result = await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);

    expect(raced).toBe(true);
    expect(result).toMatchObject({ status: 200, json: { name: 'SPEECH_API_KEY', created: false } });
    expect(database.environmentVariables).toHaveLength(1);
    await expect(resolve(USER_1)).resolves.toMatchObject({ json: { variables: { SPEECH_API_KEY: VALUES.SPEECH_API_KEY } } });
  });

  it('replaces the name a concurrent put added when that put also filled the limit', async () => {
    fillTo(USER_1, 99);
    let raced = false;
    database.beforeRequest = (request) => {
      if (!raced && request.table === 'rpc/insert_environment_variable') {
        raced = true;
        database.environmentVariables.push(concurrentRow(USER_1, 'SPEECH_API_KEY'));
      }
    };

    const result = await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);

    expect(raced).toBe(true);
    expect(result).toMatchObject({ status: 200, json: { created: false } });
    expect(database.environmentVariables.filter((row) => row.user_id === USER_1)).toHaveLength(100);
  });

  it('does not return or log the value, also when it replaces one', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put(USER_1, 'SPEECH_API_KEY', VALUES.PUBLISH_TOKEN);

    expectNoValue(responseTexts);
    expectNoValue(logLines);
  });
});

describe('resolve', () => {
  it('does not open a row whose updated_at was changed, because the envelope belongs to the last change', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    (rowFor(USER_1, 'SPEECH_API_KEY') as InMemoryEnvironmentVariableRow).updated_at = '2026-01-01T00:00:00.000Z';

    await expect(resolve(USER_1)).resolves.toEqual({ status: 500, json: { error: 'decrypt_failed' } });
  });

  it('does not open a ciphertext that was sealed as a provider key', async () => {
    const sealed = await sealProviderKey({
      plaintextKey: VALUES.SPEECH_API_KEY,
      binding: { userID: USER_1, provider: 'openai', keyVersion: 1, createdAt: '2026-10-13T00:00:00.000Z' },
      keyEncryptionKeySecrets: [CURRENT_SECRET],
    });
    database.environmentVariables.push({
      user_id: USER_1,
      name: 'SPEECH_API_KEY',
      ciphertext: sealed.ciphertext,
      iv: sealed.initializationVector,
      wrapped_dek: sealed.wrappedDataEncryptionKey,
      dek_iv: sealed.dataEncryptionKeyInitializationVector,
      key_version: 1,
      created_at: '2026-10-13T00:00:00.000Z',
      updated_at: '2026-10-13T00:00:00.000Z',
    });

    await expect(resolve(USER_1)).resolves.toEqual({ status: 500, json: { error: 'decrypt_failed' } });
  });

  it('opens a row sealed with the previous key encryption key', async () => {
    environment = createEnvironment({ PROVIDER_KEY_KEK: PREVIOUS_SECRET });
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);

    environment = createEnvironment({ PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_PREVIOUS: PREVIOUS_SECRET });

    await expect(resolve(USER_1)).resolves.toEqual({ status: 200, json: { variables: { SPEECH_API_KEY: VALUES.SPEECH_API_KEY } } });
  });

  it('fails the whole call, answering no value at all, when one row does not open', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put(USER_1, 'PUBLISH_TOKEN', VALUES.PUBLISH_TOKEN);
    (rowFor(USER_1, 'PUBLISH_TOKEN') as InMemoryEnvironmentVariableRow).ciphertext = 'dGFtcGVyZWQ=';

    const result = await resolve(USER_1);

    expect(result).toEqual({ status: 500, json: { error: 'decrypt_failed' } });
    expectNoValue(responseTexts);
    const failureLine = logLines.find((line) => line.includes('Environment variable decryption failed'));
    expect(failureLine).toContain(USER_1);
    expect(failureLine).toContain('PUBLISH_TOKEN');
    expectNoValue(logLines);
  });
});

describe('list', () => {
  it('never reads a ciphertext column', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    database.requests.length = 0;

    await list(USER_1);

    expect(database.requests).toHaveLength(1);
    expect(database.requests[0].query.get('select')).not.toMatch(/ciphertext|wrapped_dek|iv/);
  });
});

describe('delete', () => {
  it('rejects a name that breaks the rules without touching the database', async () => {
    await expect(remove(USER_1, 'lower')).resolves.toEqual({ status: 400, json: { error: 'invalid_request' } });

    expect(database.requests).toEqual([]);
  });
});

describe('every route', () => {
  it('requires a JSON object body with a userId', async () => {
    for (const path of ['list', 'put', 'delete', 'resolve']) {
      for (const body of ['not json', '', '[]', '"text"', 'null', '42']) {
        await expect(post(`/internal/environment-variables/${path}`, body), `${path} ${body}`).resolves.toEqual({
          status: 400,
          json: { error: 'invalid_request' },
        });
      }
    }
    expect(database.requests).toEqual([]);
  });

  it('does not know other routes under the prefix', async () => {
    for (const path of ['/internal/environment-variables', '/internal/environment-variables/status', '/internal/environment-variables/put/extra', '/internal/environment-variables/']) {
      await expect(call(path, { userId: USER_1 }), path).resolves.toEqual({ status: 404, json: { error: 'not_found' } });
    }
  });
});

describe('without a key encryption key', () => {
  it('answers 503 vault_unavailable to put, and stores nothing, whether the secret is missing or empty', async () => {
    for (const secret of [undefined, '']) {
      environment = createEnvironment({ PROVIDER_KEY_KEK: secret });
      await expect(put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY)).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    }

    expect(database.environmentVariables).toEqual([]);
    expect(database.requests).toEqual([]);
  });

  it('lists and deletes the rows that exist but cannot resolve them, until the last is deleted', async () => {
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put(USER_1, 'PUBLISH_TOKEN', VALUES.PUBLISH_TOKEN);
    environment = createEnvironment({ PROVIDER_KEY_KEK: undefined });

    expect(((await list(USER_1)).json.variables as unknown[]).length).toBe(2);
    await expect(resolve(USER_1)).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    await expect(resolve(USER_2)).resolves.toEqual({ status: 200, json: { variables: {} } });
    await expect(remove(USER_1, 'SPEECH_API_KEY')).resolves.toEqual({ status: 200, json: { deleted: true } });
    await expect(resolve(USER_1)).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    await expect(remove(USER_1, 'PUBLISH_TOKEN')).resolves.toEqual({ status: 200, json: { deleted: true } });
    await expect(resolve(USER_1)).resolves.toEqual({ status: 200, json: { variables: {} } });
  });

  it('keeps the key routes unavailable', async () => {
    environment = createEnvironment({ PROVIDER_KEY_KEK: undefined });

    for (const path of ['/internal/keys/status', '/internal/keys/put', '/internal/keys/delete', '/internal/keys/rewrap', '/internal/proxy']) {
      await expect(call(path, { userId: USER_1, provider: 'openai' }), path).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    }
  });
});

describe('/internal/keys/rewrap', () => {
  it('counts nothing for a user without environment variables', async () => {
    await expect(call('/internal/keys/rewrap', { userId: USER_1 })).resolves.toEqual({
      status: 200,
      json: { rewrapped: 0, unrecoverable: 0, environment_variables_rewrapped: 0, environment_variables_unrecoverable: 0 },
    });
  });

  it('leaves alone the rows it cannot open and the rows of other users', async () => {
    environment = createEnvironment({ PROVIDER_KEY_KEK: PREVIOUS_SECRET });
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put(USER_2, 'OTHER_USERS', VALUES.OTHER_USER_VALUE);
    await put(USER_1, 'MOVED_NAME', VALUES.PUBLISH_TOKEN);
    (rowFor(USER_1, 'MOVED_NAME') as InMemoryEnvironmentVariableRow).name = 'ZZ_MOVED';
    const before = database.environmentVariables.map((row) => ({ ...row }));

    environment = createEnvironment({ PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_PREVIOUS: PREVIOUS_SECRET });
    const result = await call('/internal/keys/rewrap', { userId: USER_1 });

    expect(result.json).toMatchObject({ environment_variables_rewrapped: 1, environment_variables_unrecoverable: 1 });
    expect(rowFor(USER_1, 'ZZ_MOVED')).toEqual(before.find((row) => row.name === 'ZZ_MOVED'));
    expect(rowFor(USER_2, 'OTHER_USERS')).toEqual(before.find((row) => row.user_id === USER_2));
    await expect(openRow(rowFor(USER_1, 'SPEECH_API_KEY') as InMemoryEnvironmentVariableRow, USER_1, [CURRENT_SECRET])).resolves.toBe(VALUES.SPEECH_API_KEY);
    expectNoValue(responseTexts);
    expectNoValue(logLines);
  });

  it('does not overwrite a row a concurrent put replaced while it was rewrapping', async () => {
    environment = createEnvironment({ PROVIDER_KEY_KEK: PREVIOUS_SECRET });
    await put(USER_1, 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    environment = createEnvironment({ PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_PREVIOUS: PREVIOUS_SECRET });
    let replaced = false;
    database.beforeRequest = (request) => {
      // The rewrap changes the wrapped data encryption key only; a put changes the ciphertext too
      const changes = request.body as Record<string, unknown> | undefined;
      if (!replaced && request.method === 'PATCH' && request.table === 'environment_variables' && changes !== undefined && !('ciphertext' in changes)) {
        replaced = true;
        (rowFor(USER_1, 'SPEECH_API_KEY') as InMemoryEnvironmentVariableRow).wrapped_dek = 'cmVwbGFjZWQtYnktcHV0';
      }
    };

    const result = await call('/internal/keys/rewrap', { userId: USER_1 });

    expect(replaced).toBe(true);
    expect(result.json).toMatchObject({ environment_variables_rewrapped: 0, environment_variables_unrecoverable: 0 });
    expect(rowFor(USER_1, 'SPEECH_API_KEY')?.wrapped_dek).toBe('cmVwbGFjZWQtYnktcHV0');
  });
});
