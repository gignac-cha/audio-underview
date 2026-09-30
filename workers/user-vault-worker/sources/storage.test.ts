import { describe, expect, it } from 'vitest';
import { FakeDatabase, type FakeProviderKeyRow } from './fake-database.ts';
import { clampAuditEventLimit, createUserVaultStorage, type ProviderKeyRecord } from './storage.ts';

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

function row(overrides: Partial<FakeProviderKeyRow> = {}): FakeProviderKeyRow {
  return {
    user_id: 'user-1',
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
    const database = new FakeDatabase();
    const first = createUserVaultStorage(database.asD1Database(), 'user-1');
    const second = createUserVaultStorage(database.asD1Database(), 'user-2');

    await first.writeProviderKey(record());
    await expect(first.readProviderKey('openai')).resolves.toEqual(record());
    await expect(second.readProviderKey('openai')).resolves.toBeNull();
    await expect(second.listProviderKeys()).resolves.toEqual([]);
    expect(database.providerKeys).toHaveLength(1);
    expect(database.providerKeys[0]?.user_id).toBe('user-1');
  });

  it('replaces every envelope column on conflict', async () => {
    const database = new FakeDatabase();
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
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
  });

  it('ignores rows with an unknown provider', async () => {
    const database = new FakeDatabase();
    database.providerKeys.push(row({ provider: 'mistral' }), row({ provider: 'google' }));
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    const records = await storage.listProviderKeys();
    expect(records.map((candidate) => candidate.provider)).toEqual(['google']);
  });

  it('deletes only the bound user and provider and reports whether a row was removed', async () => {
    const database = new FakeDatabase();
    database.providerKeys.push(
      row({ provider: 'openai' }),
      row({ provider: 'google' }),
      row({ user_id: 'user-2', provider: 'openai' }),
    );
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    await expect(storage.deleteProviderKey('openai')).resolves.toBe(true);
    await expect(storage.deleteProviderKey('openai')).resolves.toBe(false);
    expect(database.providerKeys.map((candidate) => `${candidate.user_id}/${candidate.provider}`)).toEqual([
      'user-1/google',
      'user-2/openai',
    ]);
  });

  it('replaces only the wrapped data encryption key columns, and only when the row is unchanged', async () => {
    const database = new FakeDatabase();
    database.providerKeys.push(row());
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    const replacement = { wrappedDataEncryptionKey: 'bmV3', dataEncryptionKeyInitializationVector: 'bmV3LWl2' };

    await expect(storage.replaceWrappedDataEncryptionKey('openai', 'stale', replacement)).resolves.toBe(false);
    await expect(storage.replaceWrappedDataEncryptionKey('openai', 'd3JhcHBlZA==', replacement)).resolves.toBe(true);
    expect(database.providerKeys[0]).toEqual(row({ wrapped_dek: 'bmV3', dek_iv: 'bmV3LWl2' }));
  });

  it('reads audit events newest first, skipping unknown actions and other users', async () => {
    const database = new FakeDatabase();
    database.insertAuditRow({ user_id: 'user-1', provider: 'openai', action: 'registered', at: 'A', ip_hash: 'h', ua_hash: null });
    database.insertAuditRow({ user_id: 'user-2', provider: 'openai', action: 'used', at: 'B', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: 'user-1', provider: 'openai', action: 'tampered', at: 'C', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: 'user-1', provider: 'mistral', action: 'used', at: 'D', ip_hash: null, ua_hash: null });
    database.insertAuditRow({ user_id: 'user-1', provider: 'google', action: 'used', at: 'E', ip_hash: null, ua_hash: 'u' });
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
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

    const database = new FakeDatabase();
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    await storage.listAuditEvents(1000);
    expect(database.executedStatements.at(-1)?.values).toEqual(['user-1', 200]);
  });

  it('binds userId in every statement, lists columns, and only inserts into or reads the audit table', async () => {
    const database = new FakeDatabase();
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
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

    expect(database.executedStatements).toHaveLength(7);
    for (const statement of database.executedStatements) {
      expect(statement.values).toContain('user-1');
      expect(statement.sql).not.toMatch(/SELECT \*/i);
      if (/^(SELECT|UPDATE|DELETE)/.test(statement.sql)) {
        expect(statement.sql).toContain('user_id = ?');
      }
      if (statement.sql.includes('key_audit_log')) {
        expect(statement.sql).toMatch(/^(INSERT|SELECT)/);
      }
    }
  });
});
