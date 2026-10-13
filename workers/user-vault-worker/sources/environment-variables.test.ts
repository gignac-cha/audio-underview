import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProviderKey } from './envelope.ts';
import type { Environment } from './environment.ts';
import { FakeDatabase, type FakeEnvironmentVariableRow } from './fake-database.ts';
import worker from './index.ts';

const WORKER_ORIGIN = 'https://user-vault.internal';
const CURRENT_SECRET = 'current-key-encryption-secret';
const PREVIOUS_SECRET = 'previous-key-encryption-secret';
const INTERNAL_TOKEN = 'internal-token-for-tests';

const VALUES = {
  SPEECH_API_KEY: 'speech-secret-value-0123456789',
  SITE_TOKEN: 'site-token-value-abcdef',
  OTHER_USER_KEY: 'other-user-secret-value-9876',
};
const ALL_VALUES = Object.values(VALUES);

interface Harness {
  database: FakeDatabase;
  environment: Environment;
  responseTexts: string[];
  logLines: string[];
}

let harness: Harness;

function createHarness(overrides: Partial<Environment> = {}, database: FakeDatabase = new FakeDatabase()): Harness {
  harness = {
    database,
    environment: {
      DB: database.asD1Database(),
      PROVIDER_KEY_KEK: CURRENT_SECRET,
      PROVIDER_KEY_KEK_VERSION: '1',
      ...overrides,
    },
    responseTexts: harness?.responseTexts ?? [],
    logLines: harness?.logLines ?? [],
  };
  return harness;
}

beforeEach(() => {
  harness = undefined as unknown as Harness;
  const logLines: string[] = [];
  for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logLines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
    });
  }
  createHarness();
  harness.logLines = logLines;
  // No route of this file reaches the network
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('Unexpected fetch');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function call(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`${WORKER_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, harness.environment);
  const text = await response.text();
  harness.responseTexts.push(text);
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

function put(userID: string, name: string, value: string) {
  return call('/internal/environment-variables/put', { userId: userID, name, value });
}

function resolve(userID: string) {
  return call('/internal/environment-variables/resolve', { userId: userID });
}

function rowFor(userID: string, name: string): FakeEnvironmentVariableRow | undefined {
  return harness.database.environmentVariables.find((row) => row.user_id === userID && row.name === name);
}

function openRow(row: FakeEnvironmentVariableRow, userID: string, name: string = row.name, secrets: string[] = [CURRENT_SECRET]) {
  return openProviderKey({
    userID,
    envelope: {
      provider: `environment-variable:${name}`,
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

function expectNoValue(texts: string[]) {
  for (const text of texts) {
    for (const value of ALL_VALUES) {
      expect(text).not.toContain(value);
    }
  }
}

describe('/internal/environment-variables/put', () => {
  it('creates a variable sealed for the user and the name, and answers without the value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00.000Z'));

    const result = await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);

    expect(result).toEqual({
      status: 200,
      json: {
        name: 'SPEECH_API_KEY',
        created_at: '2026-10-13T00:00:00.000Z',
        updated_at: '2026-10-13T00:00:00.000Z',
        created: true,
      },
    });
    const row = rowFor('user-1', 'SPEECH_API_KEY') as FakeEnvironmentVariableRow;
    expect(JSON.stringify(row)).not.toContain(VALUES.SPEECH_API_KEY);
    expect(row.key_version).toBe(1);
    expect(row).not.toHaveProperty('last4');
    await expect(openRow(row, 'user-1')).resolves.toBe(VALUES.SPEECH_API_KEY);
    expectNoValue(harness.responseTexts);
  });

  it('replaces the value with a new envelope, keeping created_at', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T00:00:00.000Z'));
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    const before = { ...rowFor('user-1', 'SITE_TOKEN') } as FakeEnvironmentVariableRow;

    vi.setSystemTime(new Date('2026-10-14T00:00:00.000Z'));
    const result = await put('user-1', 'SITE_TOKEN', 'replacement-site-token');

    expect(result).toEqual({
      status: 200,
      json: {
        name: 'SITE_TOKEN',
        created_at: '2026-10-13T00:00:00.000Z',
        updated_at: '2026-10-14T00:00:00.000Z',
        created: false,
      },
    });
    const after = rowFor('user-1', 'SITE_TOKEN') as FakeEnvironmentVariableRow;
    expect(harness.database.environmentVariables).toHaveLength(1);
    for (const column of ['ciphertext', 'iv', 'wrapped_dek', 'dek_iv', 'updated_at'] as const) {
      expect(after[column]).not.toBe(before[column]);
    }
    expect(after.created_at).toBe('2026-10-13T00:00:00.000Z');
    await expect(openRow(after, 'user-1')).resolves.toBe('replacement-site-token');
  });

  it('writes the configured key generation', async () => {
    createHarness({ PROVIDER_KEY_KEK_VERSION: '3' });
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    expect(rowFor('user-1', 'SITE_TOKEN')?.key_version).toBe(3);
    await expect(resolve('user-1')).resolves.toEqual({ status: 200, json: { variables: { SITE_TOKEN: VALUES.SITE_TOKEN } } });
  });

  it('rejects a name or a value outside the rules with 400 before anything else', async () => {
    const invalidBodies = [
      { name: 'lower_case', value: 'abcd' },
      { name: '1STARTS_WITH_DIGIT', value: 'abcd' },
      { name: 'HAS-HYPHEN', value: 'abcd' },
      { name: `A${'B'.repeat(64)}`, value: 'abcd' },
      { name: '', value: 'abcd' },
      { name: 42, value: 'abcd' },
      { value: 'abcd' },
      { name: 'VALID', value: 'abc' },
      { name: 'VALID', value: 'v'.repeat(16_385) },
      { name: 'VALID', value: 1234 },
      { name: 'VALID' },
    ];
    for (const body of invalidBodies) {
      await expect(call('/internal/environment-variables/put', { userId: 'user-1', ...body })).resolves.toEqual({
        status: 400,
        json: { error: 'invalid_request' },
      });
    }
    expect(harness.database.executedStatements).toEqual([]);

    // The body is checked before the key encryption key
    createHarness({ PROVIDER_KEY_KEK: undefined }, harness.database);
    await expect(put('user-1', 'lower', 'abcd')).resolves.toEqual({ status: 400, json: { error: 'invalid_request' } });
  });

  it('accepts the boundaries of the rules', async () => {
    await expect(put('user-1', '_', 'abcd')).resolves.toMatchObject({ status: 200 });
    await expect(put('user-1', `A${'B'.repeat(63)}`, 'v'.repeat(16_384))).resolves.toMatchObject({ status: 200 });
    await expect(put('user-1', 'A_1', 'abcd')).resolves.toMatchObject({ status: 200 });
  });

  it('allows 100 variables per user and refuses the 101st with 409', async () => {
    for (let index = 0; index < 100; index += 1) {
      await expect(put('user-1', `NAME_${index}`, `value-${index}`)).resolves.toMatchObject({ status: 200, json: { created: true } });
    }
    await expect(put('user-1', 'ONE_TOO_MANY', 'value-101')).resolves.toEqual({ status: 409, json: { error: 'limit_exceeded' } });
    expect(rowFor('user-1', 'ONE_TOO_MANY')).toBeUndefined();

    // Replacing an existing name does not count against the limit
    await expect(put('user-1', 'NAME_7', 'new-value-7')).resolves.toMatchObject({ status: 200, json: { created: false } });
    // The limit is per user
    await expect(put('user-2', 'NAME_0', 'value-of-user-2')).resolves.toMatchObject({ status: 200, json: { created: true } });
  });

  it('replaces the value when the same name was inserted concurrently', async () => {
    harness.database.beforeEnvironmentVariableInsert = () => {
      harness.database.beforeEnvironmentVariableInsert = null;
      harness.database.environmentVariables.push({
        user_id: 'user-1',
        name: 'SITE_TOKEN',
        ciphertext: 'Y29uY3VycmVudA==',
        iv: 'aXY=',
        wrapped_dek: 'd3JhcHBlZA==',
        dek_iv: 'ZGVrLWl2',
        key_version: 1,
        created_at: '2026-10-12T00:00:00.000Z',
        updated_at: '2026-10-12T00:00:00.000Z',
      });
    };

    const result = await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);

    expect(result).toMatchObject({ status: 200, json: { name: 'SITE_TOKEN', created_at: '2026-10-12T00:00:00.000Z', created: false } });
    expect(harness.database.environmentVariables).toHaveLength(1);
    await expect(resolve('user-1')).resolves.toEqual({ status: 200, json: { variables: { SITE_TOKEN: VALUES.SITE_TOKEN } } });
  });
});

describe('/internal/environment-variables/list', () => {
  it('lists the names and times of the user by name, without values', async () => {
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    await put('user-2', 'OTHER_USER_KEY', VALUES.OTHER_USER_KEY);

    const result = await call('/internal/environment-variables/list', { userId: 'user-1' });

    expect(result.status).toBe(200);
    const variables = result.json.variables as { name: string; created_at: string; updated_at: string }[];
    expect(variables.map((variable) => variable.name)).toEqual(['SITE_TOKEN', 'SPEECH_API_KEY']);
    for (const variable of variables) {
      expect(Object.keys(variable).sort()).toEqual(['created_at', 'name', 'updated_at']);
    }
    expectNoValue(harness.responseTexts);
  });

  it('is empty for a user without variables', async () => {
    await expect(call('/internal/environment-variables/list', { userId: 'nobody' })).resolves.toEqual({
      status: 200,
      json: { variables: [] },
    });
  });
});

describe('/internal/environment-variables/delete', () => {
  it('deletes only the given user and name', async () => {
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-2', 'SITE_TOKEN', VALUES.OTHER_USER_KEY);

    await expect(call('/internal/environment-variables/delete', { userId: 'user-1', name: 'SITE_TOKEN' })).resolves.toEqual({
      status: 200,
      json: { deleted: true },
    });
    expect(rowFor('user-1', 'SITE_TOKEN')).toBeUndefined();
    expect(rowFor('user-1', 'SPEECH_API_KEY')).toBeDefined();
    expect(rowFor('user-2', 'SITE_TOKEN')).toBeDefined();
  });

  it('answers deleted: false for a name that does not exist, and 400 for an invalid name', async () => {
    await expect(call('/internal/environment-variables/delete', { userId: 'user-1', name: 'MISSING' })).resolves.toEqual({
      status: 200,
      json: { deleted: false },
    });
    await expect(call('/internal/environment-variables/delete', { userId: 'user-1', name: 'missing' })).resolves.toEqual({
      status: 400,
      json: { error: 'invalid_request' },
    });
  });
});

describe('/internal/environment-variables/resolve', () => {
  it('returns the names and values of the user only', async () => {
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    await put('user-2', 'OTHER_USER_KEY', VALUES.OTHER_USER_KEY);

    await expect(resolve('user-1')).resolves.toEqual({
      status: 200,
      json: { variables: { SPEECH_API_KEY: VALUES.SPEECH_API_KEY, SITE_TOKEN: VALUES.SITE_TOKEN } },
    });
    await expect(resolve('user-2')).resolves.toEqual({
      status: 200,
      json: { variables: { OTHER_USER_KEY: VALUES.OTHER_USER_KEY } },
    });
    await expect(resolve('nobody')).resolves.toEqual({ status: 200, json: { variables: {} } });
  });

  it('does not open a ciphertext moved from another user', async () => {
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    await put('user-2', 'SITE_TOKEN', VALUES.OTHER_USER_KEY);
    // Put the other user's envelope in user-1's row
    const victim = rowFor('user-1', 'SITE_TOKEN') as FakeEnvironmentVariableRow;
    const moved = rowFor('user-2', 'SITE_TOKEN') as FakeEnvironmentVariableRow;
    Object.assign(victim, { ...moved, user_id: 'user-1' });

    await expect(resolve('user-1')).resolves.toEqual({ status: 500, json: { error: 'decrypt_failed' } });
  });

  it('does not open a ciphertext moved to another name', async () => {
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    (rowFor('user-1', 'SITE_TOKEN') as FakeEnvironmentVariableRow).name = 'RENAMED';

    await expect(resolve('user-1')).resolves.toEqual({ status: 500, json: { error: 'decrypt_failed' } });
  });

  it('fails closed with 500 when one row cannot be opened, logging only the user and the name', async () => {
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    (rowFor('user-1', 'SITE_TOKEN') as FakeEnvironmentVariableRow).ciphertext = 'Y29ycnVwdGVk';

    const result = await resolve('user-1');

    expect(result).toEqual({ status: 500, json: { error: 'decrypt_failed' } });
    const failureLines = harness.logLines.filter((line) => line.includes('Environment variable decryption failed'));
    expect(failureLines).toHaveLength(1);
    expect(failureLines[0]).toContain('user-1');
    expect(failureLines[0]).toContain('SITE_TOKEN');
    expectNoValue(harness.responseTexts);
    expectNoValue(harness.logLines);
  });

  it('does not open rows sealed with another key encryption key', async () => {
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    createHarness({ PROVIDER_KEY_KEK: 'another-key-encryption-secret' }, harness.database);

    await expect(resolve('user-1')).resolves.toEqual({ status: 500, json: { error: 'decrypt_failed' } });
  });
});

describe('internal token', () => {
  it('guards every environment variable route like the key routes', async () => {
    createHarness({ VAULT_INTERNAL_TOKEN: INTERNAL_TOKEN });
    for (const path of ['list', 'put', 'delete', 'resolve']) {
      const body = { userId: 'user-1', name: 'SITE_TOKEN', value: VALUES.SITE_TOKEN };
      await expect(call(`/internal/environment-variables/${path}`, body)).resolves.toEqual({
        status: 401,
        json: { error: 'unauthorized' },
      });
      await expect(call(`/internal/environment-variables/${path}`, body, { 'x-user-vault-token': 'wrong' })).resolves.toEqual({
        status: 401,
        json: { error: 'unauthorized' },
      });
    }
    expect(harness.database.executedStatements).toEqual([]);
    await expect(
      call('/internal/environment-variables/resolve', { userId: 'user-1' }, { 'x-user-vault-token': INTERNAL_TOKEN }),
    ).resolves.toEqual({ status: 200, json: { variables: {} } });
  });

  it('checks userId on every environment variable route', async () => {
    for (const path of ['list', 'put', 'delete', 'resolve']) {
      for (const body of [{}, { userId: '' }, { userId: 'u'.repeat(201) }, { userId: 42 }]) {
        await expect(call(`/internal/environment-variables/${path}`, body)).resolves.toEqual({
          status: 400,
          json: { error: 'invalid_request' },
        });
      }
    }
  });
});

describe('without a key encryption key', () => {
  it('answers 503 on the key routes and on put, before reading anything', async () => {
    createHarness({ PROVIDER_KEY_KEK: undefined });
    for (const [path, body] of [
      ['/internal/keys/put', { userId: 'user-1', provider: 'openai', key: 'sk-proj-openaiTestKey0123456789abcd' }],
      // An unknown provider is still answered with 503 first, as before
      ['/internal/keys/put', { userId: 'user-1', provider: 'mistral' }],
      ['/internal/keys/delete', { userId: 'user-1', provider: 'openai' }],
      ['/internal/keys/status', { userId: 'user-1' }],
      ['/internal/keys/audit', { userId: 'user-1' }],
      ['/internal/keys/rewrap', { userId: 'user-1' }],
      ['/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models' }],
      ['/internal/environment-variables/put', { userId: 'user-1', name: 'SITE_TOKEN', value: VALUES.SITE_TOKEN }],
    ] as const) {
      await expect(call(path, body)).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    }
    expect(harness.database.executedStatements).toEqual([]);
    expect(harness.logLines.some((line) => line.includes('Key encryption key is not configured'))).toBe(true);
  });

  it('lists, deletes and resolves a user without rows', async () => {
    const database = new FakeDatabase();
    createHarness({}, database);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    createHarness({ PROVIDER_KEY_KEK: '' }, database);

    await expect(call('/internal/environment-variables/list', { userId: 'user-1' })).resolves.toMatchObject({
      status: 200,
      json: { variables: [{ name: 'SITE_TOKEN' }] },
    });
    await expect(resolve('user-2')).resolves.toEqual({ status: 200, json: { variables: {} } });
    await expect(call('/internal/environment-variables/delete', { userId: 'user-1', name: 'SITE_TOKEN' })).resolves.toEqual({
      status: 200,
      json: { deleted: true },
    });
    await expect(resolve('user-1')).resolves.toEqual({ status: 200, json: { variables: {} } });
  });

  it('answers 503 on resolve for a user with rows', async () => {
    const database = new FakeDatabase();
    createHarness({}, database);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    createHarness({ PROVIDER_KEY_KEK: undefined }, database);

    await expect(resolve('user-1')).resolves.toEqual({ status: 503, json: { error: 'vault_unavailable' } });
  });
});

describe('/internal/keys/rewrap', () => {
  it('moves the environment variables to the new key encryption key and counts rows it cannot open', async () => {
    const database = new FakeDatabase();
    createHarness({ PROVIDER_KEY_KEK: PREVIOUS_SECRET }, database);
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-1', 'SITE_TOKEN', VALUES.SITE_TOKEN);
    await put('user-2', 'OTHER_USER_KEY', VALUES.OTHER_USER_KEY);
    // A row of another user moved to user-1 cannot be opened
    (rowFor('user-2', 'OTHER_USER_KEY') as FakeEnvironmentVariableRow).user_id = 'user-1';
    const before = database.environmentVariables.map((row) => ({ ...row }));

    createHarness({ PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_PREVIOUS: PREVIOUS_SECRET }, database);
    const result = await call('/internal/keys/rewrap', { userId: 'user-1' });

    expect(result).toEqual({
      status: 200,
      json: { rewrapped: 0, unrecoverable: 0, environment_variables_rewrapped: 2, environment_variables_unrecoverable: 1 },
    });
    for (const name of ['SPEECH_API_KEY', 'SITE_TOKEN'] as const) {
      const previous = before.find((row) => row.name === name) as FakeEnvironmentVariableRow;
      const current = rowFor('user-1', name) as FakeEnvironmentVariableRow;
      expect(current.ciphertext).toBe(previous.ciphertext);
      expect(current.iv).toBe(previous.iv);
      expect(current.created_at).toBe(previous.created_at);
      expect(current.updated_at).toBe(previous.updated_at);
      expect(current.wrapped_dek).not.toBe(previous.wrapped_dek);
      await expect(openRow(current, 'user-1', name, [CURRENT_SECRET])).resolves.toBe(VALUES[name]);
      await expect(openRow(current, 'user-1', name, [PREVIOUS_SECRET])).resolves.toBeNull();
    }

    // The previous key encryption key can go now
    createHarness({ PROVIDER_KEY_KEK: CURRENT_SECRET }, database);
    (rowFor('user-1', 'OTHER_USER_KEY') as FakeEnvironmentVariableRow).user_id = 'user-2';
    await expect(resolve('user-1')).resolves.toEqual({
      status: 200,
      json: { variables: { SPEECH_API_KEY: VALUES.SPEECH_API_KEY, SITE_TOKEN: VALUES.SITE_TOKEN } },
    });
  });
});

describe('values', () => {
  it('never appear in a response or a log line other than resolve', async () => {
    await put('user-1', 'SPEECH_API_KEY', VALUES.SPEECH_API_KEY);
    await put('user-1', 'SPEECH_API_KEY', VALUES.SITE_TOKEN);
    await put('user-2', 'OTHER_USER_KEY', VALUES.OTHER_USER_KEY);
    await call('/internal/environment-variables/list', { userId: 'user-1' });
    await call('/internal/keys/rewrap', { userId: 'user-1' });
    await call('/internal/environment-variables/delete', { userId: 'user-1', name: 'SPEECH_API_KEY' });
    for (let index = 0; index < 100; index += 1) {
      await put('user-3', `NAME_${index}`, `value-${index}`);
    }
    await put('user-3', 'OVER_LIMIT', VALUES.SITE_TOKEN);

    expectNoValue(harness.responseTexts);
    expectNoValue(harness.logLines);
  });
});
