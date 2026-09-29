import { createWorkerLogger } from '@audio-underview/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIT_ACTIONS,
  extractAuditFingerprint,
  hashAuditFingerprint,
  hashAuditValue,
  isAuditAction,
  recordAuditEvent,
} from './audit.ts';
import { FakeDatabase } from './fake-database.ts';
import { createUserVaultStorage } from './storage.ts';

const IP = '203.0.113.7';
const USER_AGENT = 'Mozilla/5.0 (Macintosh) AudioUnderview/1.0';

async function expectedHash(salt: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\n${value}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audit actions', () => {
  it('accepts only registered, replaced, removed and used', () => {
    expect(AUDIT_ACTIONS).toEqual(['registered', 'replaced', 'removed', 'used']);
    for (const action of AUDIT_ACTIONS) {
      expect(isAuditAction(action)).toBe(true);
    }
    for (const value of ['deleted', 'updated', 'Registered', '', null, undefined, 1]) {
      expect(isAuditAction(value)).toBe(false);
    }
  });
});

describe('extractAuditFingerprint', () => {
  it('takes only ip and userAgent from the body', () => {
    const fingerprint = extractAuditFingerprint({
      userId: 'user-1',
      provider: 'openai',
      key: 'sk-proj-abcdefghijklmnop',
      ip: IP,
      userAgent: USER_AGENT,
      referer: 'https://example.com',
    });
    expect(fingerprint).toEqual({ ip: IP, userAgent: USER_AGENT });
  });

  it('drops empty and non-string values', () => {
    expect(extractAuditFingerprint({ ip: '', userAgent: '' })).toEqual({ ip: null, userAgent: null });
    expect(extractAuditFingerprint({ ip: 1234, userAgent: { name: 'x' } })).toEqual({ ip: null, userAgent: null });
    expect(extractAuditFingerprint({ ip: ['1.1.1.1'], userAgent: null })).toEqual({ ip: null, userAgent: null });
    expect(extractAuditFingerprint({})).toEqual({ ip: null, userAgent: null });
  });
});

describe('hashAuditValue', () => {
  it('is the hex SHA-256 of <salt>\\n<value>', async () => {
    await expect(hashAuditValue('pepper', IP)).resolves.toBe(await expectedHash('pepper', IP));
    await expect(hashAuditValue('', IP)).resolves.toBe(await expectedHash('', IP));
    await expect(hashAuditValue('pepper', IP)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('is equal for the same salt and different for another salt', async () => {
    expect(await hashAuditValue('salt-a', IP)).toBe(await hashAuditValue('salt-a', IP));
    expect(await hashAuditValue('salt-a', IP)).not.toBe(await hashAuditValue('salt-b', IP));
  });

  it('keeps the two fields apart', async () => {
    const hashed = await hashAuditFingerprint('salt-a', { ip: IP, userAgent: USER_AGENT });
    expect(hashed.ipHash).toBe(await expectedHash('salt-a', IP));
    expect(hashed.userAgentHash).toBe(await expectedHash('salt-a', USER_AGENT));
    expect(hashed.ipHash).not.toBe(hashed.userAgentHash);
  });

  it('gives null for a missing value and never contains the original value', async () => {
    expect(await hashAuditFingerprint('salt-a', { ip: null, userAgent: null })).toEqual({
      ipHash: null,
      userAgentHash: null,
    });
    const hashed = await hashAuditFingerprint('salt-a', { ip: IP, userAgent: null });
    expect(hashed.userAgentHash).toBeNull();
    expect(hashed.ipHash).not.toContain(IP);
    expect(hashed.ipHash).not.toContain('203');
  });
});

describe('recordAuditEvent', () => {
  it('stores the salted hashes and NULL for missing values', async () => {
    const database = new FakeDatabase();
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    const logger = createWorkerLogger({ enabled: false });
    await recordAuditEvent({
      storage,
      logger,
      salt: 'salt-a',
      provider: 'openai',
      action: 'used',
      fingerprint: { ip: IP, userAgent: null },
      at: '2026-09-29T00:00:00.000Z',
    });
    expect(database.auditLog).toEqual([
      {
        id: 1,
        user_id: 'user-1',
        provider: 'openai',
        action: 'used',
        at: '2026-09-29T00:00:00.000Z',
        ip_hash: await expectedHash('salt-a', IP),
        ua_hash: null,
      },
    ]);
  });

  it('logs and swallows a failed write', async () => {
    const database = new FakeDatabase();
    database.brokenTables.add('key_audit_log');
    const storage = createUserVaultStorage(database.asD1Database(), 'user-1');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createWorkerLogger({ defaultContext: { module: 'api-key-vault-worker' } });
    await expect(
      recordAuditEvent({
        storage,
        logger,
        salt: '',
        provider: 'google',
        action: 'registered',
        fingerprint: { ip: null, userAgent: null },
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('Audit event write failed');
    expect(database.auditLog).toEqual([]);
  });
});
