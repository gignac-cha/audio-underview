import { describe, expect, it } from 'vitest';
import {
  readAuditHashSalt,
  readGatewayOptions,
  readInternalToken,
  readKeyEncryptionKeySecrets,
  readKeyEncryptionKeyVersion,
  type Environment,
} from './environment.ts';

function environment(overrides: Partial<Environment> = {}): Environment {
  return { DB: {} as D1Database, ...overrides };
}

describe('readKeyEncryptionKeySecrets', () => {
  it('is empty when the current key encryption key is missing or empty', () => {
    expect(readKeyEncryptionKeySecrets(environment())).toEqual([]);
    expect(readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK: '' }))).toEqual([]);
    expect(readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK_PREVIOUS: 'previous' }))).toEqual([]);
  });

  it('puts the current key first and appends a different previous key', () => {
    expect(readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK: 'current' }))).toEqual(['current']);
    expect(
      readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK: 'current', PROVIDER_KEY_KEK_PREVIOUS: 'previous' })),
    ).toEqual(['current', 'previous']);
  });

  it('skips a previous key that is empty or equal to the current one', () => {
    expect(
      readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK: 'current', PROVIDER_KEY_KEK_PREVIOUS: 'current' })),
    ).toEqual(['current']);
    expect(
      readKeyEncryptionKeySecrets(environment({ PROVIDER_KEY_KEK: 'current', PROVIDER_KEY_KEK_PREVIOUS: '' })),
    ).toEqual(['current']);
  });
});

describe('readKeyEncryptionKeyVersion', () => {
  it('reads a positive integer', () => {
    expect(readKeyEncryptionKeyVersion(environment({ PROVIDER_KEY_KEK_VERSION: '1' }))).toBe(1);
    expect(readKeyEncryptionKeyVersion(environment({ PROVIDER_KEY_KEK_VERSION: '7' }))).toBe(7);
  });

  it('falls back to 1 for anything that is not a positive integer', () => {
    for (const value of [undefined, '', '0', '-2', '1.5', 'two', '1e3', '99999999999999999999']) {
      expect(readKeyEncryptionKeyVersion(environment({ PROVIDER_KEY_KEK_VERSION: value }))).toBe(1);
    }
  });
});

describe('readInternalToken', () => {
  it('is null unless a non-empty token is set', () => {
    expect(readInternalToken(environment())).toBeNull();
    expect(readInternalToken(environment({ VAULT_INTERNAL_TOKEN: '' }))).toBeNull();
    expect(readInternalToken(environment({ VAULT_INTERNAL_TOKEN: 'token' }))).toBe('token');
  });
});

describe('readGatewayOptions', () => {
  it('is null unless the base URL is non-empty after trimming', () => {
    expect(readGatewayOptions(environment())).toBeNull();
    expect(readGatewayOptions(environment({ AI_GATEWAY_BASE_URL: '' }))).toBeNull();
    expect(readGatewayOptions(environment({ AI_GATEWAY_BASE_URL: '   \n' }))).toBeNull();
    expect(readGatewayOptions(environment({ AI_GATEWAY_TOKEN: 'token' }))).toBeNull();
  });

  it('trims the base URL and carries the token only when it is set', () => {
    expect(readGatewayOptions(environment({ AI_GATEWAY_BASE_URL: '  https://gateway.example.com/v1/a/b  ' }))).toEqual({
      baseURL: 'https://gateway.example.com/v1/a/b',
      token: null,
    });
    expect(
      readGatewayOptions(
        environment({ AI_GATEWAY_BASE_URL: 'https://gateway.example.com/v1/a/b', AI_GATEWAY_TOKEN: 'token' }),
      ),
    ).toEqual({ baseURL: 'https://gateway.example.com/v1/a/b', token: 'token' });
  });
});

describe('readAuditHashSalt', () => {
  it('uses an empty string when no salt is set', () => {
    expect(readAuditHashSalt(environment())).toBe('');
    expect(readAuditHashSalt(environment({ AUDIT_HASH_SALT: 'salt' }))).toBe('salt');
  });
});
