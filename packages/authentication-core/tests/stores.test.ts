import { describe, expect, it } from 'vitest';
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
} from '../sources/stores/authorization-code-store.ts';
import { consumeOAuthState, createOAuthState } from '../sources/stores/state-store.ts';
import {
  issueRefreshToken,
  rotateRefreshToken,
} from '../sources/stores/refresh-token-store.ts';
import { createFakeKV, testUser } from './test-helpers.ts';

describe('state store', () => {
  it('round-trips a state record and consumes it (single-use)', async () => {
    const kv = createFakeKV();
    const record = {
      provider: 'x' as const,
      redirectURI: 'https://app.example.com/authentication/callback',
      codeVerifier: 'verifier-123',
    };
    const state = await createOAuthState(kv, record);

    expect(await consumeOAuthState(kv, 'x', state)).toEqual(record);
    expect(await consumeOAuthState(kv, 'x', state)).toBeUndefined();
  });

  it('namespaces states per provider', async () => {
    const kv = createFakeKV();
    const state = await createOAuthState(kv, {
      provider: 'google',
      redirectURI: 'https://app.example.com/callback',
    });
    expect(await consumeOAuthState(kv, 'github', state)).toBeUndefined();
    expect(await consumeOAuthState(kv, 'google', state)).toBeDefined();
  });
});

describe('authorization code store', () => {
  it('is single-use', async () => {
    const kv = createFakeKV();
    const code = await createAuthorizationCode(kv, { user: testUser });

    expect(await consumeAuthorizationCode(kv, code)).toEqual({ user: testUser });
    expect(await consumeAuthorizationCode(kv, code)).toBeUndefined();
  });

  it('returns undefined for unknown codes', async () => {
    const kv = createFakeKV();
    expect(await consumeAuthorizationCode(kv, 'unknown')).toBeUndefined();
  });
});

describe('refresh token rotation', () => {
  it('rotates an active token and keeps the user', async () => {
    const kv = createFakeKV();
    const first = await issueRefreshToken(kv, testUser);

    const rotation = await rotateRefreshToken(kv, first);
    expect(rotation.outcome).toBe('rotated');
    if (rotation.outcome !== 'rotated') {
      return;
    }
    expect(rotation.user).toEqual(testUser);
    expect(rotation.refreshToken).not.toBe(first);
  });

  it('detects reuse and revokes the whole family', async () => {
    const kv = createFakeKV();
    const first = await issueRefreshToken(kv, testUser);
    const rotation = await rotateRefreshToken(kv, first);
    expect(rotation.outcome).toBe('rotated');
    if (rotation.outcome !== 'rotated') {
      return;
    }

    // 소비된 토큰 재사용 → 탈취 간주
    expect((await rotateRefreshToken(kv, first)).outcome).toBe('reuse_detected');
    // family가 폐기되었으므로 새 토큰도 무효
    expect((await rotateRefreshToken(kv, rotation.refreshToken)).outcome).toBe('invalid');
  });

  it('rejects unknown tokens', async () => {
    const kv = createFakeKV();
    expect((await rotateRefreshToken(kv, 'unknown')).outcome).toBe('invalid');
  });
});
