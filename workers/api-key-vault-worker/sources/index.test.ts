import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64, openProviderKey } from './envelope.ts';
import type { Environment } from './environment.ts';
import { FakeDatabase, type FakeProviderKeyRow } from './fake-database.ts';
import worker from './index.ts';
import type { ProviderName } from './providers.ts';

const WORKER_ORIGIN = 'https://api-key-vault.internal';
const CURRENT_SECRET = 'current-key-encryption-secret';
const PREVIOUS_SECRET = 'previous-key-encryption-secret';
const INTERNAL_TOKEN = 'internal-token-for-tests';
const GATEWAY_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/vault-account/vault-gateway';

const KEYS: Record<ProviderName, string> = {
  anthropic: 'sk-ant-api03-AAAAbbbbCCCCdddd-1111',
  openai: 'sk-proj-openaiTestKey0123456789abcd',
  google: 'AIzaSyD-1234567890abcdefgHIJKLmnop',
  xai: 'xai-abcdef1234567890ABCDEF',
};
const OTHER_OPENAI_KEY = 'sk-proj-anotherUsersKey9876543210wxyz';
const ALL_KEYS = [...Object.values(KEYS), OTHER_OPENAI_KEY];

interface ProviderCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
  redirect: string | undefined;
  auditActionsAtCall: string[];
}

interface Harness {
  database: FakeDatabase;
  environment: Environment;
  providerCalls: ProviderCall[];
  validationCalls: ProviderCall[];
  responseTexts: string[];
  logLines: string[];
  currentRoute: string;
  respond: (call: ProviderCall) => Response | Promise<Response>;
  validate: (call: ProviderCall) => Response | Promise<Response>;
}

let harness: Harness;

function createHarness(overrides: Partial<Environment> = {}, database: FakeDatabase = new FakeDatabase()): Harness {
  const created: Harness = {
    database,
    environment: {
      DB: database.asD1Database(),
      PROVIDER_KEY_KEK: CURRENT_SECRET,
      PROVIDER_KEY_KEK_VERSION: '1',
      ...overrides,
    },
    providerCalls: [],
    validationCalls: [],
    responseTexts: [],
    logLines: harness?.logLines ?? [],
    currentRoute: '',
    respond: () =>
      new Response('{"id":"message-1"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    validate: () => new Response('{"data":[]}', { status: 200 }),
  };
  harness = created;
  return created;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

async function captureCall(input: RequestInfo | URL, init?: RequestInit): Promise<ProviderCall> {
  const request = new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: headersToRecord(request.headers),
    body: new Uint8Array(await request.arrayBuffer()),
    redirect: init?.redirect,
    auditActionsAtCall: harness.database.auditLog.map((row) => row.action),
  };
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = await captureCall(input, init);
      // Only the put route validates keys, so every fetch made while it runs is a validation call.
      if (harness.currentRoute === '/internal/keys/put') {
        harness.validationCalls.push(call);
        return harness.validate(call);
      }
      harness.providerCalls.push(call);
      return harness.respond(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  rawBody?: string;
}

async function call(
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = options.method ?? 'POST';
  harness.currentRoute = path;
  const request = new Request(`${WORKER_ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: method === 'GET' ? undefined : (options.rawBody ?? JSON.stringify(body)),
  });
  const response = await worker.fetch(request, harness.environment);
  const text = await response.text();
  harness.responseTexts.push(text);
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

async function register(
  userID: string,
  provider: ProviderName,
  key: string = KEYS[provider],
  extra: Record<string, unknown> = {},
) {
  const result = await call('/internal/keys/put', { userId: userID, provider, key, ...extra });
  expect(result.status).toBe(200);
  return result;
}

function rowFor(userID: string, provider: ProviderName): FakeProviderKeyRow | undefined {
  return harness.database.providerKeys.find((row) => row.user_id === userID && row.provider === provider);
}

function openRow(row: FakeProviderKeyRow, userID: string, secrets: string[] = [CURRENT_SECRET]) {
  return openProviderKey({
    userID,
    envelope: {
      provider: row.provider,
      ciphertext: row.ciphertext,
      initializationVector: row.iv,
      wrappedDataEncryptionKey: row.wrapped_dek,
      dataEncryptionKeyInitializationVector: row.dek_iv,
      keyVersion: row.key_version,
      createdAt: row.created_at,
    },
    keyEncryptionKeySecrets: secrets,
  });
}

function auditActions(userID: string): string[] {
  return harness.database.auditLog.filter((row) => row.user_id === userID).map((row) => row.action);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectNoPlaintextKey(texts: string[]) {
  for (const text of texts) {
    for (const key of ALL_KEYS) {
      expect(text).not.toContain(key);
    }
  }
}

describe('request handling', () => {
  it('returns 404 for GET', async () => {
    const result = await call('/internal/keys/status', undefined, { method: 'GET' });
    expect(result).toEqual({ status: 404, json: { error: 'not_found' } });
  });

  it('returns 404 for an unknown path', async () => {
    for (const path of ['/', '/internal/keys', '/internal/keys/put/extra', '/internal/keys/list', '/toString']) {
      const result = await call(path, { userId: 'user-1' });
      expect(result).toEqual({ status: 404, json: { error: 'not_found' } });
    }
  });

  it('returns 400 when userId is missing or not a 1 to 200 character string', async () => {
    for (const body of [{}, { userId: '' }, { userId: 'u'.repeat(201) }, { userId: 42 }, { userId: null }]) {
      const result = await call('/internal/keys/status', body);
      expect(result).toEqual({ status: 400, json: { error: 'invalid_request' } });
    }
    await expect(call('/internal/keys/status', { userId: 'u'.repeat(200) })).resolves.toMatchObject({ status: 200 });
  });

  it('returns 400 when the body is not a JSON object', async () => {
    for (const rawBody of ['not json', '[]', '"user-1"', 'null', '42']) {
      const result = await call('/internal/keys/status', undefined, { rawBody });
      expect(result).toEqual({ status: 400, json: { error: 'invalid_request' } });
    }
  });

  it('returns 503 without a key encryption key and stores nothing', async () => {
    for (const secret of [undefined, '']) {
      createHarness({ PROVIDER_KEY_KEK: secret });
      const result = await call('/internal/keys/put', { userId: 'user-1', provider: 'openai', key: KEYS.openai });
      expect(result).toEqual({ status: 503, json: { error: 'vault_unavailable' } });
    }
    expect(harness.database.providerKeys).toEqual([]);
    expect(harness.database.executedStatements).toEqual([]);
    expect(harness.validationCalls).toEqual([]);
    expect(harness.logLines.some((line) => line.includes('"level":"error"'))).toBe(true);
  });

  it('does not require the internal token when it is not configured', async () => {
    await expect(call('/internal/keys/status', { userId: 'user-1' })).resolves.toMatchObject({ status: 200 });
  });

  it('requires the internal token header with the exact value when it is configured', async () => {
    createHarness({ VAULT_INTERNAL_TOKEN: INTERNAL_TOKEN });
    await expect(call('/internal/keys/status', { userId: 'user-1' })).resolves.toEqual({
      status: 401,
      json: { error: 'unauthorized' },
    });
    await expect(
      call('/internal/keys/status', { userId: 'user-1' }, { headers: { 'x-provider-key-vault-token': 'wrong' } }),
    ).resolves.toEqual({ status: 401, json: { error: 'unauthorized' } });
    await expect(
      call(
        '/internal/keys/status',
        { userId: 'user-1' },
        { headers: { 'x-provider-key-vault-token': `${INTERNAL_TOKEN}x` } },
      ),
    ).resolves.toEqual({ status: 401, json: { error: 'unauthorized' } });
    await expect(
      call('/internal/unknown', { userId: 'user-1' }, { headers: { 'x-provider-key-vault-token': 'wrong' } }),
    ).resolves.toEqual({ status: 401, json: { error: 'unauthorized' } });
    await expect(
      call('/internal/keys/status', { userId: 'user-1' }, { headers: { 'x-provider-key-vault-token': INTERNAL_TOKEN } }),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe('/internal/keys/put', () => {
  it('stores an envelope without the plaintext key', async () => {
    const result = await register('user-1', 'openai');
    const row = rowFor('user-1', 'openai');
    expect(row).toBeDefined();
    expect(result.json).toEqual({
      provider: 'openai',
      configured: true,
      last4: 'abcd',
      validatedAt: row?.validated_at,
    });
    expect(JSON.stringify(row)).not.toContain(KEYS.openai);
    expect(row?.created_at).toBe(row?.validated_at);
    expect(row?.key_version).toBe(1);
    expect(row?.last4).toBe('abcd');
    expect(Number.isNaN(Date.parse(row?.created_at ?? ''))).toBe(false);
    await expect(openRow(row as FakeProviderKeyRow, 'user-1')).resolves.toBe(KEYS.openai);
    expect(harness.validationCalls).toHaveLength(1);
  });

  it('writes the configured key generation on new rows', async () => {
    createHarness({ PROVIDER_KEY_KEK_VERSION: '3' });
    await register('user-1', 'google');
    expect(rowFor('user-1', 'google')?.key_version).toBe(3);
  });

  it('does not store a key for an unknown provider', async () => {
    const result = await call('/internal/keys/put', { userId: 'user-1', provider: 'mistral', key: KEYS.openai });
    expect(result).toEqual({ status: 400, json: { error: 'unknown_provider' } });
    expect(harness.database.providerKeys).toEqual([]);
    expect(harness.validationCalls).toEqual([]);
  });

  it('does not store a key the provider rejects', async () => {
    for (const status of [400, 401, 403]) {
      harness.validate = () => new Response('{"error":"invalid x-api-key"}', { status });
      const result = await call('/internal/keys/put', { userId: 'user-1', provider: 'anthropic', key: KEYS.anthropic });
      expect(result).toEqual({ status: 400, json: { error: 'invalid_key' } });
    }
    expect(harness.database.providerKeys).toEqual([]);
    expect(harness.database.auditLog).toEqual([]);
  });

  it('does not store a key when validation is unavailable', async () => {
    harness.validate = () => new Response('overloaded', { status: 529 });
    await expect(
      call('/internal/keys/put', { userId: 'user-1', provider: 'xai', key: KEYS.xai }),
    ).resolves.toEqual({ status: 503, json: { error: 'validation_unavailable' } });
    harness.validate = () => {
      throw new TypeError('Network connection lost.');
    };
    await expect(
      call('/internal/keys/put', { userId: 'user-1', provider: 'xai', key: KEYS.xai }),
    ).resolves.toEqual({ status: 503, json: { error: 'validation_unavailable' } });
    expect(harness.database.providerKeys).toEqual([]);
    expect(harness.database.auditLog).toEqual([]);
  });

  it('does not validate through a gateway base that is not https', async () => {
    createHarness({ AI_GATEWAY_BASE_URL: 'http://gateway.example.com/v1/a/b', AI_GATEWAY_TOKEN: 'vault-gateway-token' });
    await expect(
      call('/internal/keys/put', { userId: 'user-1', provider: 'openai', key: KEYS.openai }),
    ).resolves.toEqual({ status: 503, json: { error: 'validation_unavailable' } });
    expect(harness.validationCalls).toEqual([]);
    expect(harness.providerCalls).toEqual([]);
    expect(harness.database.providerKeys).toEqual([]);
  });

  it('does not call the provider for a malformed key', async () => {
    for (const key of ['short', ` ${KEYS.openai}`, `${KEYS.openai}\n`, 12345678901234567890, undefined]) {
      const result = await call('/internal/keys/put', { userId: 'user-1', provider: 'openai', key });
      expect(result).toEqual({ status: 400, json: { error: 'invalid_key' } });
    }
    expect(harness.validationCalls).toEqual([]);
    expect(harness.providerCalls).toEqual([]);
    expect(harness.database.providerKeys).toEqual([]);
  });

  it('builds a whole new envelope when a key is replaced', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    await register('user-1', 'openai');
    const before = { ...rowFor('user-1', 'openai') } as FakeProviderKeyRow;

    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    const replacementKey = 'sk-proj-replacementKey0123456789wxyz';
    const result = await register('user-1', 'openai', replacementKey);
    const after = rowFor('user-1', 'openai') as FakeProviderKeyRow;

    expect(harness.database.providerKeys).toHaveLength(1);
    for (const column of ['ciphertext', 'iv', 'wrapped_dek', 'dek_iv', 'last4', 'created_at', 'validated_at'] as const) {
      expect(after[column]).not.toBe(before[column]);
    }
    expect(after.created_at).toBe('2026-09-30T00:00:00.000Z');
    expect(result.json).toMatchObject({ last4: 'wxyz', validatedAt: '2026-09-30T00:00:00.000Z' });
    await expect(openRow(after, 'user-1')).resolves.toBe(replacementKey);
  });

  it('keeps users apart', async () => {
    await register('user-a', 'openai', KEYS.openai);
    await register('user-b', 'openai', OTHER_OPENAI_KEY);
    await expect(openRow(rowFor('user-a', 'openai') as FakeProviderKeyRow, 'user-a')).resolves.toBe(KEYS.openai);
    await expect(openRow(rowFor('user-b', 'openai') as FakeProviderKeyRow, 'user-b')).resolves.toBe(OTHER_OPENAI_KEY);

    const statusA = await call('/internal/keys/status', { userId: 'user-a' });
    const statusB = await call('/internal/keys/status', { userId: 'user-b' });
    expect((statusA.json.keys as { last4: string | null }[])[1]?.last4).toBe('abcd');
    expect((statusB.json.keys as { last4: string | null }[])[1]?.last4).toBe('wxyz');

    await call('/internal/proxy', { userId: 'user-b', provider: 'openai', path: 'v1/models', method: 'GET' });
    expect(harness.providerCalls.at(-1)?.headers.authorization).toBe(`Bearer ${OTHER_OPENAI_KEY}`);
  });
});

describe('/internal/keys/status', () => {
  it('always lists four providers in a fixed order and exposes only last4', async () => {
    await register('user-1', 'google');
    const result = await call('/internal/keys/status', { userId: 'user-1' });
    const row = rowFor('user-1', 'google');
    expect(result).toEqual({
      status: 200,
      json: {
        keys: [
          { provider: 'anthropic', configured: false, last4: null, validatedAt: null },
          { provider: 'openai', configured: false, last4: null, validatedAt: null },
          { provider: 'google', configured: true, last4: 'mnop', validatedAt: row?.validated_at },
          { provider: 'xai', configured: false, last4: null, validatedAt: null },
        ],
      },
    });
    const text = harness.responseTexts.at(-1) ?? '';
    for (const value of [row?.ciphertext, row?.iv, row?.wrapped_dek, row?.dek_iv]) {
      expect(text).not.toContain(value);
    }
  });

  it('lists four providers for a user without rows', async () => {
    const result = await call('/internal/keys/status', { userId: 'nobody' });
    expect(result.json.keys).toEqual([
      { provider: 'anthropic', configured: false, last4: null, validatedAt: null },
      { provider: 'openai', configured: false, last4: null, validatedAt: null },
      { provider: 'google', configured: false, last4: null, validatedAt: null },
      { provider: 'xai', configured: false, last4: null, validatedAt: null },
    ]);
  });
});

describe('/internal/keys/delete', () => {
  it('removes only the given user and provider', async () => {
    await register('user-a', 'openai');
    await register('user-a', 'google');
    await register('user-b', 'openai', OTHER_OPENAI_KEY);
    await expect(call('/internal/keys/delete', { userId: 'user-a', provider: 'openai' })).resolves.toEqual({
      status: 200,
      json: { removed: true },
    });
    expect(harness.database.providerKeys.map((row) => `${row.user_id}/${row.provider}`)).toEqual([
      'user-a/google',
      'user-b/openai',
    ]);
  });

  it('reports removed: false for a key that did not exist', async () => {
    await expect(call('/internal/keys/delete', { userId: 'user-a', provider: 'xai' })).resolves.toEqual({
      status: 200,
      json: { removed: false },
    });
  });

  it('rejects an unknown provider', async () => {
    await expect(call('/internal/keys/delete', { userId: 'user-a', provider: 'mistral' })).resolves.toEqual({
      status: 400,
      json: { error: 'unknown_provider' },
    });
  });
});

describe('/internal/proxy', () => {
  it('decrypts the key and attaches the provider authentication headers', async () => {
    await register('user-1', 'anthropic');
    const result = await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'anthropic',
      path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', 'anthropic-beta': 'prompt-caching-2024-07-31' },
      body: '{"model":"claude-haiku-4-5-20251001"}',
    });
    expect(result).toEqual({
      status: 200,
      json: {
        ok: true,
        provider: 'anthropic',
        status: 200,
        contentType: 'application/json',
        body: '{"id":"message-1"}',
      },
    });
    const providerCall = harness.providerCalls.at(-1);
    expect(providerCall?.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(providerCall?.method).toBe('POST');
    expect(providerCall?.headers['x-api-key']).toBe(KEYS.anthropic);
    expect(providerCall?.headers['anthropic-version']).toBe('2023-06-01');
    expect(providerCall?.headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    expect(new TextDecoder().decode(providerCall?.body)).toBe('{"model":"claude-haiku-4-5-20251001"}');
  });

  it('keeps the key out of the response even when the provider echoes it back', async () => {
    await register('user-1', 'openai');
    harness.respond = (providerCall) =>
      new Response(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${providerCall.headers.authorization}` } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    const result = await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models' });
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ ok: true, status: 401 });
    expect(harness.responseTexts.at(-1)).not.toContain(KEYS.openai);
  });

  it('ignores caller authentication headers', async () => {
    await register('user-1', 'google');
    await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'google',
      path: 'v1beta/models',
      method: 'GET',
      headers: {
        authorization: 'Bearer caller-supplied-key',
        'x-api-key': 'caller-supplied-key',
        'X-Goog-Api-Key': 'caller-supplied-key',
      },
    });
    const providerCall = harness.providerCalls.at(-1);
    expect(providerCall?.headers['x-goog-api-key']).toBe(KEYS.google);
    expect(providerCall?.headers).not.toHaveProperty('authorization');
    expect(providerCall?.headers).not.toHaveProperty('x-api-key');
    expect(JSON.stringify(providerCall?.headers)).not.toContain('caller-supplied-key');
  });

  it('answers no_key for an unregistered provider, another user, and a moved row', async () => {
    await register('user-a', 'openai');
    const noKey = { status: 404, json: { ok: false, error: 'no_key' } };

    await expect(call('/internal/proxy', { userId: 'user-a', provider: 'xai', path: 'v1/models' })).resolves.toEqual(noKey);
    await expect(call('/internal/proxy', { userId: 'user-b', provider: 'openai', path: 'v1/models' })).resolves.toEqual(noKey);

    const row = rowFor('user-a', 'openai') as FakeProviderKeyRow;
    row.user_id = 'user-b';
    await expect(call('/internal/proxy', { userId: 'user-b', provider: 'openai', path: 'v1/models' })).resolves.toEqual(noKey);

    expect(harness.providerCalls).toEqual([]);
    const decryptionLog = harness.logLines.find((line) => line.includes('Provider key decryption failed'));
    expect(decryptionLog).toContain('"provider":"openai"');
    expect(decryptionLog).toContain('"keyVersion":1');
  });

  it('checks the URL before reading the key and never leaves through a caller-chosen gateway namespace', async () => {
    const rejected = await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'openai',
      path: 'https://evil.example.com/v1/models',
    });
    expect(rejected).toEqual({ status: 400, json: { ok: false, error: 'invalid_path' } });
    expect(harness.database.executedStatements).toEqual([]);

    createHarness({ AI_GATEWAY_BASE_URL: GATEWAY_BASE_URL });
    await register('user-1', 'openai');
    const statementsBefore = harness.database.executedStatements.length;
    const traversal = await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'openai',
      path: 'v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker-account/attacker-gateway/openai/v1/chat/completions',
    });
    expect(traversal).toEqual({ status: 400, json: { ok: false, error: 'invalid_path' } });
    expect(harness.database.executedStatements).toHaveLength(statementsBefore);
    expect(harness.providerCalls).toEqual([]);
  });

  it('rejects a path that is not a string, and an unknown provider', async () => {
    await expect(call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 42 })).resolves.toEqual({
      status: 400,
      json: { ok: false, error: 'invalid_path' },
    });
    await expect(call('/internal/proxy', { userId: 'user-1', provider: 'mistral', path: 'v1/models' })).resolves.toEqual({
      status: 400,
      json: { ok: false, error: 'unknown_provider' },
    });
  });

  it('uppercases the method, defaults to POST, and rejects methods outside the list', async () => {
    await register('user-1', 'xai');
    await call('/internal/proxy', { userId: 'user-1', provider: 'xai', path: 'v1/models', method: 'get' });
    await call('/internal/proxy', { userId: 'user-1', provider: 'xai', path: 'v1/chat/completions', body: '{}' });
    expect(harness.providerCalls.map((providerCall) => providerCall.method)).toEqual(['GET', 'POST']);

    for (const method of ['HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 42, null]) {
      await expect(
        call('/internal/proxy', { userId: 'user-1', provider: 'xai', path: 'v1/models', method }),
      ).resolves.toEqual({ status: 400, json: { ok: false, error: 'invalid_request' } });
    }
    expect(harness.providerCalls).toHaveLength(2);
  });

  it('answers 502 on a connection failure without quoting the request', async () => {
    await register('user-1', 'openai');
    harness.respond = (providerCall) => {
      throw new TypeError(`connect ECONNREFUSED while sending ${new TextDecoder().decode(providerCall.body)}`);
    };
    const result = await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'openai',
      path: 'v1/chat/completions',
      body: '{"prompt":"confidential prompt text"}',
    });
    expect(result).toEqual({ status: 502, json: { ok: false, error: 'provider_unreachable' } });
    expect(harness.responseTexts.at(-1)).not.toContain('confidential');
    expect(harness.logLines.some((line) => line.includes('Provider fetch failed'))).toBe(true);
  });

  it('answers 502 when the provider response body breaks halfway', async () => {
    await register('user-1', 'openai');
    harness.respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('stream reset'));
          },
        }),
        { status: 200 },
      );
    await expect(
      call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' }),
    ).resolves.toEqual({ status: 502, json: { ok: false, error: 'provider_unreachable' } });
  });

  it('sends the key with redirect: manual on both the validation call and the proxy call', async () => {
    await register('user-1', 'openai');
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' });
    expect(harness.validationCalls).toHaveLength(1);
    expect(harness.providerCalls).toHaveLength(1);
    expect(harness.validationCalls[0]?.redirect).toBe('manual');
    expect(harness.providerCalls[0]?.redirect).toBe('manual');
  });

  it('passes a redirect through as data instead of following it', async () => {
    await register('user-1', 'openai');
    harness.respond = () =>
      new Response('Found', {
        status: 302,
        headers: { location: 'https://evil.example.com/collect', 'content-type': 'text/plain' },
      });
    await expect(
      call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' }),
    ).resolves.toEqual({
      status: 200,
      json: { ok: true, provider: 'openai', status: 302, contentType: 'text/plain', body: 'Found' },
    });
    expect(harness.providerCalls.map((providerCall) => providerCall.url)).toEqual(['https://api.openai.com/v1/models']);
  });

  it('refuses a gateway base that is not https before reading the key', async () => {
    const database = new FakeDatabase();
    createHarness({}, database);
    await register('user-1', 'openai');
    createHarness(
      { AI_GATEWAY_BASE_URL: 'http://gateway.example.com/v1/a/b', AI_GATEWAY_TOKEN: 'vault-gateway-token' },
      database,
    );
    const statementsBefore = database.executedStatements.length;
    await expect(
      call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' }),
    ).resolves.toEqual({ status: 400, json: { ok: false, error: 'blocked_origin' } });
    expect(harness.providerCalls).toEqual([]);
    expect(database.executedStatements).toHaveLength(statementsBefore);
  });

  it('passes provider errors through as data', async () => {
    await register('user-1', 'google');
    harness.respond = () => new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } });
    await expect(
      call('/internal/proxy', { userId: 'user-1', provider: 'google', path: 'v1beta/models:generateContent' }),
    ).resolves.toEqual({
      status: 200,
      json: { ok: true, provider: 'google', status: 429, contentType: 'text/plain', body: 'rate limited' },
    });

    harness.respond = () => new Response(new Uint8Array([104, 105]), { status: 500 });
    const withoutContentType = await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'google',
      path: 'v1beta/models',
    });
    expect(withoutContentType.json).toMatchObject({ status: 500, contentType: 'application/octet-stream', body: 'hi' });
  });

  it('sends a binary body byte for byte and keeps the content-type boundary', async () => {
    await register('user-1', 'openai');
    const boundary = '----vault-boundary-7MA4YWxkTrZu0gW';
    const prefix = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    );
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f, 0x0d, 0x0a, 0xc3, 0x28]);
    const bytes = new Uint8Array([...prefix, ...binary, ...suffix]);

    await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'openai',
      path: 'v1/audio/transcriptions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      bodyBase64: encodeBase64(bytes),
    });
    const providerCall = harness.providerCalls.at(-1);
    expect(providerCall?.headers['content-type']).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(Array.from(providerCall?.body ?? [])).toEqual(Array.from(bytes));
  });

  it('rejects text and binary together, bodies that are not base64 or strings, and bodies over the limit', async () => {
    await register('user-1', 'openai');
    const invalid = { status: 400, json: { ok: false, error: 'invalid_request' } };
    const base = { userId: 'user-1', provider: 'openai', path: 'v1/files' };

    await expect(call('/internal/proxy', { ...base, body: 'text', bodyBase64: 'aGk=' })).resolves.toEqual(invalid);
    await expect(call('/internal/proxy', { ...base, bodyBase64: '%%%not-base64%%%' })).resolves.toEqual(invalid);
    await expect(call('/internal/proxy', { ...base, bodyBase64: 42 })).resolves.toEqual(invalid);
    await expect(call('/internal/proxy', { ...base, body: { prompt: 'x' } })).resolves.toEqual(invalid);
    await expect(call('/internal/proxy', { ...base, bodyBase64: 'A'.repeat(16_000_004) })).resolves.toEqual(invalid);
    expect(harness.providerCalls).toEqual([]);
  });

  it('rejects a GET that carries a body instead of reporting the provider unreachable', async () => {
    await register('user-1', 'openai');
    const invalid = { status: 400, json: { ok: false, error: 'invalid_request' } };
    const base = { userId: 'user-1', provider: 'openai', path: 'v1/models' };

    await expect(call('/internal/proxy', { ...base, method: 'GET', body: '{}' })).resolves.toEqual(invalid);
    await expect(call('/internal/proxy', { ...base, method: 'get', bodyBase64: 'aGk=' })).resolves.toEqual(invalid);
    expect(harness.providerCalls).toEqual([]);
  });

  it('uses only the vault gateway settings', async () => {
    createHarness({ AI_GATEWAY_BASE_URL: ` ${GATEWAY_BASE_URL}/ `, AI_GATEWAY_TOKEN: 'vault-gateway-token' });
    await register('user-1', 'openai');
    harness.validationCalls = [];
    await call('/internal/proxy', {
      userId: 'user-1',
      provider: 'openai',
      path: 'v1/chat/completions',
      body: '{}',
      gateway: 'https://gateway.ai.cloudflare.com/v1/attacker-account/attacker-gateway',
      AI_GATEWAY_BASE_URL: 'https://attacker.example.com',
      headers: { 'cf-aig-authorization': 'Bearer attacker-gateway-token', 'content-type': 'application/json' },
    });
    const providerCall = harness.providerCalls.at(-1);
    expect(providerCall?.url).toBe(`${GATEWAY_BASE_URL}/openai/chat/completions`);
    expect(providerCall?.headers['cf-aig-authorization']).toBe('Bearer vault-gateway-token');
    expect(providerCall?.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(harness.providerCalls.every((candidate) => candidate.url.startsWith(GATEWAY_BASE_URL))).toBe(true);
  });
});

describe('/internal/keys/rewrap', () => {
  it('moves every row to the new key encryption key without touching the key ciphertext and counts rows it cannot open', async () => {
    const database = new FakeDatabase();
    createHarness({ PROVIDER_KEY_KEK: PREVIOUS_SECRET }, database);
    await register('user-1', 'openai');
    await register('user-1', 'google');
    await register('user-2', 'anthropic');
    const moved = rowFor('user-2', 'anthropic') as FakeProviderKeyRow;
    moved.user_id = 'user-1';
    const before = database.providerKeys.map((row) => ({ ...row }));

    createHarness({ PROVIDER_KEY_KEK: CURRENT_SECRET, PROVIDER_KEY_KEK_PREVIOUS: PREVIOUS_SECRET }, database);
    const result = await call('/internal/keys/rewrap', { userId: 'user-1' });
    expect(result).toEqual({ status: 200, json: { rewrapped: 2, unrecoverable: 1 } });

    for (const provider of ['openai', 'google'] as const) {
      const previous = before.find((row) => row.provider === provider) as FakeProviderKeyRow;
      const current = rowFor('user-1', provider) as FakeProviderKeyRow;
      expect(current.ciphertext).toBe(previous.ciphertext);
      expect(current.iv).toBe(previous.iv);
      expect(current.key_version).toBe(previous.key_version);
      expect(current.created_at).toBe(previous.created_at);
      expect(current.wrapped_dek).not.toBe(previous.wrapped_dek);
      expect(current.dek_iv).not.toBe(previous.dek_iv);
      await expect(openRow(current, 'user-1', [CURRENT_SECRET])).resolves.toBe(KEYS[provider]);
      await expect(openRow(current, 'user-1', [PREVIOUS_SECRET])).resolves.toBeNull();
    }
    expect(rowFor('user-1', 'anthropic')).toEqual(before.find((row) => row.provider === 'anthropic'));
    expect(harness.providerCalls).toEqual([]);
    expect(harness.logLines.some((line) => line.includes('"rewrapped":2'))).toBe(true);
  });
});

describe('plaintext keys', () => {
  it('never appear in any response or log line', async () => {
    createHarness({ AUDIT_HASH_SALT: 'salt', AI_GATEWAY_BASE_URL: GATEWAY_BASE_URL, AI_GATEWAY_TOKEN: 'gateway-token' });
    harness.validate = () => new Response('{}', { status: 200 });
    for (const provider of ['anthropic', 'openai', 'google', 'xai'] as const) {
      await register('user-1', provider, KEYS[provider], { ip: '203.0.113.7', userAgent: 'agent' });
    }
    harness.respond = (providerCall) =>
      new Response(`echo ${JSON.stringify(providerCall.headers)}`, { status: 401 });
    for (const provider of ['anthropic', 'openai', 'google', 'xai'] as const) {
      await call('/internal/proxy', { userId: 'user-1', provider, path: 'v1/models', method: 'GET' });
    }
    harness.respond = () => {
      throw new Error(`socket closed; last header ${KEYS.openai}`);
    };
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models' });
    harness.validate = () => new Response(`bad key ${KEYS.xai}`, { status: 401 });
    await call('/internal/keys/put', { userId: 'user-1', provider: 'xai', key: KEYS.xai });
    harness.validate = () => {
      throw new Error(`timeout sending ${KEYS.google}`);
    };
    await call('/internal/keys/put', { userId: 'user-1', provider: 'google', key: KEYS.google });
    await call('/internal/keys/status', { userId: 'user-1' });
    await call('/internal/keys/audit', { userId: 'user-1' });
    await call('/internal/keys/rewrap', { userId: 'user-1' });
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });

    expect(harness.responseTexts.length).toBeGreaterThan(10);
    expectNoPlaintextKey(harness.responseTexts);
    expectNoPlaintextKey(harness.logLines);
  });
});

describe('audit log', () => {
  it('records registered for the first key and replaced for the next', async () => {
    await register('user-1', 'openai');
    await register('user-1', 'openai', 'sk-proj-replacementKey0123456789wxyz');
    expect(auditActions('user-1')).toEqual(['registered', 'replaced']);
  });

  it('records removed only when a key was actually removed', async () => {
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });
    expect(auditActions('user-1')).toEqual([]);
    await register('user-1', 'openai');
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });
    expect(auditActions('user-1')).toEqual(['registered', 'removed']);
  });

  it('records used before the provider call, and nothing for requests that never reach the key', async () => {
    await register('user-1', 'openai');
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: '../evil' });
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'TRACE' });
    await call('/internal/proxy', { userId: 'user-1', provider: 'xai', path: 'v1/models' });
    await call('/internal/proxy', { userId: 'user-1', provider: 'mistral', path: 'v1/models' });
    expect(auditActions('user-1')).toEqual(['registered']);

    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' });
    expect(auditActions('user-1')).toEqual(['registered', 'used']);
    expect(harness.providerCalls.at(-1)?.auditActionsAtCall).toEqual(['registered', 'used']);
  });

  it('stores fingerprints only as salted hashes, and NULL when they are missing', async () => {
    createHarness({ AUDIT_HASH_SALT: 'audit-salt' });
    await register('user-1', 'openai', KEYS.openai, { ip: '203.0.113.7', userAgent: 'AudioUnderview/1.0' });
    await register('user-1', 'google', KEYS.google, { ip: '', userAgent: 42 });
    const [withFingerprint, withoutFingerprint] = harness.database.auditLog;
    expect(withFingerprint?.ip_hash).toBe(await sha256Hex('audit-salt\n203.0.113.7'));
    expect(withFingerprint?.ua_hash).toBe(await sha256Hex('audit-salt\nAudioUnderview/1.0'));
    expect(JSON.stringify(withFingerprint)).not.toContain('203.0.113.7');
    expect(JSON.stringify(withFingerprint)).not.toContain('AudioUnderview');
    expect(withoutFingerprint?.ip_hash).toBeNull();
    expect(withoutFingerprint?.ua_hash).toBeNull();
  });

  it('lists events newest first without hashes, hides other users, and honours the limit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T00:00:01.000Z'));
    await register('user-1', 'openai', KEYS.openai, { ip: '203.0.113.7' });
    vi.setSystemTime(new Date('2026-09-29T00:00:02.000Z'));
    await register('user-2', 'openai', OTHER_OPENAI_KEY);
    vi.setSystemTime(new Date('2026-09-29T00:00:03.000Z'));
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' });
    vi.setSystemTime(new Date('2026-09-29T00:00:04.000Z'));
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });

    const all = await call('/internal/keys/audit', { userId: 'user-1' });
    expect(all).toEqual({
      status: 200,
      json: {
        events: [
          { provider: 'openai', action: 'removed', at: '2026-09-29T00:00:04.000Z' },
          { provider: 'openai', action: 'used', at: '2026-09-29T00:00:03.000Z' },
          { provider: 'openai', action: 'registered', at: '2026-09-29T00:00:01.000Z' },
        ],
      },
    });
    expect(harness.responseTexts.at(-1)).not.toMatch(/[0-9a-f]{64}/);

    const limited = await call('/internal/keys/audit', { userId: 'user-1', limit: 2.9 });
    expect((limited.json.events as unknown[]).length).toBe(2);
    const minimum = await call('/internal/keys/audit', { userId: 'user-1', limit: 0 });
    expect((minimum.json.events as unknown[]).length).toBe(1);
    await call('/internal/keys/audit', { userId: 'user-1', limit: '2' });
    expect(harness.database.executedStatements.at(-1)?.values).toEqual(['user-1', 50]);
    await call('/internal/keys/audit', { userId: 'user-1', limit: 500 });
    expect(harness.database.executedStatements.at(-1)?.values).toEqual(['user-1', 200]);

    const other = await call('/internal/keys/audit', { userId: 'user-2' });
    expect(other.json.events).toEqual([{ provider: 'openai', action: 'registered', at: '2026-09-29T00:00:02.000Z' }]);
  });

  it('has no route that edits or deletes events', async () => {
    await register('user-1', 'openai');
    await call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models' });
    await call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' });
    await call('/internal/keys/audit', { userId: 'user-1' });
    await call('/internal/keys/rewrap', { userId: 'user-1' });
    for (const path of ['/internal/keys/audit/delete', '/internal/keys/audit/update', '/internal/audit', '/internal/keys/audit/clear']) {
      await expect(call(path, { userId: 'user-1' })).resolves.toEqual({ status: 404, json: { error: 'not_found' } });
    }
    const auditStatements = harness.database.executedStatements.filter((statement) =>
      statement.sql.includes('key_audit_log'),
    );
    expect(auditStatements.length).toBeGreaterThan(0);
    for (const statement of auditStatements) {
      expect(statement.sql).toMatch(/^(INSERT INTO|SELECT)/);
    }
    expect(harness.database.auditLog.map((row) => row.action)).toEqual(['registered', 'used', 'removed']);
  });

  it('keeps key operations working when the audit table is broken', async () => {
    harness.database.brokenTables.add('key_audit_log');
    await expect(register('user-1', 'openai')).resolves.toMatchObject({ status: 200 });
    await expect(
      call('/internal/proxy', { userId: 'user-1', provider: 'openai', path: 'v1/models', method: 'GET' }),
    ).resolves.toMatchObject({ status: 200, json: { ok: true } });
    await expect(call('/internal/keys/delete', { userId: 'user-1', provider: 'openai' })).resolves.toEqual({
      status: 200,
      json: { removed: true },
    });
    await expect(call('/internal/keys/audit', { userId: 'user-1' })).resolves.toEqual({
      status: 200,
      json: { events: [] },
    });
    expect(harness.logLines.filter((line) => line.includes('Audit event write failed'))).toHaveLength(3);
    expect(harness.logLines.some((line) => line.includes('Audit event read failed'))).toBe(true);
  });
});
