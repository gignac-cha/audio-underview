import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase, SUPABASE_ENVIRONMENT, type InMemoryProviderKeyRow } from '../tests/in-memory-supabase.ts';
import { clampAuditEventLimit, createUserVaultStorage, type ProviderKeyRecord } from './storage.ts';

const USER_1 = '00000000-0000-4000-8000-000000000001';
const USER_2 = '00000000-0000-4000-8000-000000000002';

let database: InMemorySupabase;

beforeEach(() => {
  database = new InMemorySupabase();
  vi.stubGlobal('fetch', database.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function storageOf(userID: string) {
  return createUserVaultStorage(SUPABASE_ENVIRONMENT, userID);
}

function record(overrides: Partial<ProviderKeyRecord> = {}): ProviderKeyRecord {
  return {
    provider: 'openai',
    ciphertext: 'Y2lwaGVydGV4dA==',
    initializationVector: 'aXY=',
    wrappedDataEncryptionKey: 'd3JhcHBlZA==',
    dataEncryptionKeyInitializationVector: 'ZGVrLWl2',
    keyVersion: 1,
    last4: 'abcd',
    createdAt: '2026-09-29T00:00:00.000Z',
    validatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  };
}

function row(overrides: Partial<InMemoryProviderKeyRow> = {}): InMemoryProviderKeyRow {
  return {
    user_id: USER_1,
    provider: 'openai',
    ciphertext: 'Y2lwaGVydGV4dA==',
    iv: 'aXY=',
    wrapped_dek: 'd3JhcHBlZA==',
    dek_iv: 'ZGVrLWl2',
    key_version: 1,
    last4: 'abcd',
    created_at: '2026-09-29T00:00:00.000Z',
    validated_at: null,
    ...overrides,
  };
}

describe('createUserVaultStorage', () => {
  it('writes and reads a provider key for the bound user only', async () => {
    const first = storageOf(USER_1);
    const second = storageOf(USER_2);

    await first.writeProviderKey(record());
    await expect(first.readProviderKey('openai')).resolves.toEqual(record());
    await expect(second.readProviderKey('openai')).resolves.toBeNull();
    await expect(second.listProviderKeys()).resolves.toEqual([]);
    expect(database.providerKeys).toHaveLength(1);
    expect(database.providerKeys[0]?.user_id).toBe(USER_1);
  });

  it('replaces every envelope column on conflict', async () => {
    const storage = storageOf(USER_1);
    await storage.writeProviderKey(record());
    const replacement = record({
      ciphertext: 'bmV3',
      initializationVector: 'bmV3LWl2',
      wrappedDataEncryptionKey: 'bmV3LXdyYXBwZWQ=',
      dataEncryptionKeyInitializationVector: 'bmV3LWRlay1pdg==',
      keyVersion: 2,
      last4: 'wxyz',
      createdAt: '2026-09-30T00:00:00.000Z',
      validatedAt: '2026-09-30T00:00:00.000Z',
    });
    await storage.writeProviderKey(replacement);
    expect(database.providerKeys).toHaveLength(1);
    await expect(storage.readProviderKey('openai')).resolves.toEqual(replacement);
    expect(database.requestsOf('POST', 'provider_keys').at(-1)?.query.get('on_conflict')).toBe('user_id,provider');
  });

  it('ignores rows with an unknown provider', async () => {
    database.providerKeys.push(row({ provider: 'mistral' }), row({ provider: 'google' }));
    const storage = storageOf(USER_1);
    const records = await storage.listProviderKeys();
    expect(records.map((candidate) => candidate.provider)).toEqual(['google']);
  });

  it('deletes only the bound user and provider and reports whether a row was removed', async () => {
    database.providerKeys.push(
      row({ provider: 'openai' }),
      row({ provider: 'google' }),
      row({ user_id: USER_2, provider: 'openai' }),
    );
    const storage = storageOf(USER_1);
    await expect(storage.deleteProviderKey('openai')).resolves.toBe(true);
    await expect(storage.deleteProviderKey('openai')).resolves.toBe(false);
    expect(database.providerKeys.map((candidate) => `${candidate.user_id}/${candidate.provider}`)).toEqual([
      `${USER_1}/google`,
      `${USER_2}/openai`,
    ]);
  });

  it('replaces only the wrapped data encryption key columns, and only when the row is unchanged', async () => {
    database.providerKeys.push(row());
    const storage = storageOf(USER_1);
    const replacement = { wrappedDataEncryptionKey: 'bmV3', dataEncryptionKeyInitializationVector: 'bmV3LWl2' };

    await expect(storage.replaceWrappedDataEncryptionKey('openai', 'stale', replacement)).resolves.toBe(false);
    await expect(storage.replaceWrappedDataEncryptionKey('openai', 'd3JhcHBlZA==', replacement)).resolves.toBe(true);
    expect(database.providerKeys[0]).toEqual(row({ wrapped_dek: 'bmV3', dek_iv: 'bmV3LWl2' }));
  });

  it('reads audit events newest first, skipping unknown actions and other users', async () => {
    database.insertAuditRow({ user_id: USER_1, provider: 'openai', action: 'registered', at: 'A', ip_hash: 'h', ua_hash: null });
    database.insertAuditRow({ user_id: USER_2, provider: 'openai', action: 'used', at: 'B', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: USER_1, provider: 'openai', action: 'tampered', at: 'C', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: USER_1, provider: 'mistral', action: 'used', at: 'D', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: USER_1, provider: 'google', action: 'used', at: 'E', ip_hash: null, ua_hash: 'u' });
    const storage = storageOf(USER_1);
    await expect(storage.listAuditEvents(50)).resolves.toEqual([
      { provider: 'google', action: 'used', at: 'E' },
      { provider: 'openai', action: 'registered', at: 'A' },
    ]);
  });

  it('floors the audit limit and clamps it to 1..200', async () => {
    expect(clampAuditEventLimit(2.9)).toBe(2);
    expect(clampAuditEventLimit(0)).toBe(1);
    expect(clampAuditEventLimit(-5)).toBe(1);
    expect(clampAuditEventLimit(0.5)).toBe(1);
    expect(clampAuditEventLimit(200)).toBe(200);
    expect(clampAuditEventLimit(201)).toBe(200);
    expect(clampAuditEventLimit(Number.POSITIVE_INFINITY)).toBe(200);

    const storage = storageOf(USER_1);
    await storage.listAuditEvents(1000);
    const query = database.requests.at(-1)?.query;
    expect([query?.get('user_id'), query?.get('limit'), query?.get('order')]).toEqual([`eq.${USER_1}`, '200', 'id.desc']);
  });

  it('lists environment variable names byte by byte, as COLLATE "C" orders them', async () => {
    for (const name of ['A_B', 'AB', 'A1']) {
      database.environmentVariables.push({
        user_id: USER_1,
        name,
        ciphertext: 'Y2lwaGVydGV4dA==',
        iv: 'aXY=',
        wrapped_dek: 'd3JhcHBlZA==',
        dek_iv: 'ZGVrLWl2',
        key_version: 1,
        created_at: '2026-10-13T00:00:00.000Z',
        updated_at: '2026-10-13T00:00:00.000Z',
      });
    }
    const summaries = await storageOf(USER_1).listEnvironmentVariableSummaries();
    expect(summaries.map((summary) => summary.name)).toEqual(['A1', 'AB', 'A_B']);
    expect(database.requests.at(-1)?.query.get('order')).toBe('name.asc');
  });

  it('sends every request to the schema of the environment', async () => {
    const storage = storageOf(USER_1);
    await storage.writeProviderKey(record());
    await storage.listProviderKeys();
    await storage.insertEnvironmentVariable(
      {
        name: 'SITE_TOKEN',
        ciphertext: 'Y2lwaGVydGV4dA==',
        initializationVector: 'aXY=',
        wrappedDataEncryptionKey: 'd3JhcHBlZA==',
        dataEncryptionKeyInitializationVector: 'ZGVrLWl2',
        keyVersion: 1,
        createdAt: '2026-10-13T00:00:00.000Z',
        updatedAt: '2026-10-13T00:00:00.000Z',
      },
      100,
    );
    expect(database.requests.map((request) => request.schema)).toEqual([
      SUPABASE_ENVIRONMENT.SUPABASE_SCHEMA,
      SUPABASE_ENVIRONMENT.SUPABASE_SCHEMA,
      SUPABASE_ENVIRONMENT.SUPABASE_SCHEMA,
    ]);

    // Another schema is another environment's tables: the in-memory PostgREST refuses it as PostgREST would
    const elsewhere = createUserVaultStorage({ ...SUPABASE_ENVIRONMENT, SUPABASE_SCHEMA: 'public' }, USER_1);
    await expect(elsewhere.listProviderKeys()).rejects.toThrow(/Failed to list provider keys: The schema must be one of the following/);
  });

  it('refuses a schema that is missing or not a lowercase identifier before any request', () => {
    for (const schema of ['', 'Staging', 'staging; DROP', undefined]) {
      expect(() => createUserVaultStorage({ ...SUPABASE_ENVIRONMENT, SUPABASE_SCHEMA: schema as string }, USER_1)).toThrow(/SUPABASE_SCHEMA/);
    }
    expect(database.requests).toEqual([]);
  });

  it('throws with the reason when Supabase answers with an error', async () => {
    database.brokenTables.add('provider_keys');
    await expect(storageOf(USER_1).listProviderKeys()).rejects.toThrow(
      "Failed to list provider keys: Could not find the table 'test_schema.provider_keys' in the schema cache",
    );
  });

  it('binds userId in every request, lists columns, and only inserts into or reads the audit table', async () => {
    const storage = storageOf(USER_1);
    await storage.writeProviderKey(record());
    await storage.readProviderKey('openai');
    await storage.listProviderKeys();
    await storage.replaceWrappedDataEncryptionKey('openai', 'd3JhcHBlZA==', {
      wrappedDataEncryptionKey: 'bmV3',
      dataEncryptionKeyInitializationVector: 'bmV3LWl2',
    });
    await storage.deleteProviderKey('openai');
    await storage.appendAuditEvent({ provider: 'openai', action: 'used', at: 'A', ipHash: null, userAgentHash: null });
    await storage.listAuditEvents(10);

    expect(database.requests).toHaveLength(7);
    for (const request of database.requests) {
      if (request.method === 'POST') {
        expect((request.body as Record<string, unknown>).user_id).toBe(USER_1);
      } else {
        expect(request.query.get('user_id')).toBe(`eq.${USER_1}`);
      }
      if (request.method !== 'POST') {
        expect(request.query.get('select')).toMatch(/^[a-z0-9_]+(,[a-z0-9_]+)*$/);
      }
      if (request.table === 'key_audit_log') {
        expect(request.method).toMatch(/^(POST|GET)$/);
      }
    }
  });
});
