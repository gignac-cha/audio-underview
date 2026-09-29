import { describe, test, expect } from 'vitest';
import {
  SESSION_TOKEN_LIFETIME_SECONDS,
  createSessionTokenPayload,
  readBearerToken,
  toSessionTokenClaims,
  authenticateSessionRequest,
} from './session-tokens.ts';

describe('createSessionTokenPayload', () => {
  test('carries sub, provider and a 24 hour lifetime', () => {
    const payload = createSessionTokenPayload({
      userUUID: '83156cb5-c92a-4c75-b944-341d2d857bbf',
      provider: 'github',
      issuedAtSeconds: 1_000_000,
    });

    expect(payload).toEqual({
      sub: '83156cb5-c92a-4c75-b944-341d2d857bbf',
      provider: 'github',
      iat: 1_000_000,
      exp: 1_000_000 + SESSION_TOKEN_LIFETIME_SECONDS,
    });
    expect(SESSION_TOKEN_LIFETIME_SECONDS).toBe(86_400);
  });

  test('never emits a jid claim (the pipeline rejects those as sessions)', () => {
    const payload = createSessionTokenPayload({ userUUID: 'uuid-1', provider: 'google' });
    expect('jid' in payload).toBe(false);
  });

  test('defaults the issue time to the current wall clock', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const payload = createSessionTokenPayload({ userUUID: 'uuid-1', provider: 'google' });

    expect(payload.iat).toBeGreaterThanOrEqual(nowSeconds);
    expect(payload.exp - payload.iat).toBe(SESSION_TOKEN_LIFETIME_SECONDS);
  });
});

describe('readBearerToken', () => {
  test('reads the token from a bearer header regardless of scheme casing', () => {
    expect(readBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(readBearerToken('  Bearer   abc.def.ghi  ')).toBe('abc.def.ghi');
  });

  test('returns undefined for missing or malformed headers', () => {
    expect(readBearerToken(null)).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken('')).toBeUndefined();
    expect(readBearerToken('abc.def.ghi')).toBeUndefined();
    expect(readBearerToken('Basic abc')).toBeUndefined();
    expect(readBearerToken('Bearer')).toBeUndefined();
    expect(readBearerToken('Bearer a b')).toBeUndefined();
  });
});

describe('toSessionTokenClaims', () => {
  test('narrows a session payload', () => {
    expect(
      toSessionTokenClaims({ sub: 'uuid-1', provider: 'github', iat: 10, exp: 20 }),
    ).toEqual({ sub: 'uuid-1', provider: 'github', iat: 10, exp: 20 });
  });

  test('rejects media tokens that carry jid', () => {
    expect(
      toSessionTokenClaims({ sub: 'uuid-1', jid: 'job-1', iat: 10, exp: 20 }),
    ).toBeUndefined();
  });

  test('rejects payloads without a usable sub or timestamps', () => {
    expect(toSessionTokenClaims(null)).toBeUndefined();
    expect(toSessionTokenClaims(undefined)).toBeUndefined();
    expect(toSessionTokenClaims('token')).toBeUndefined();
    expect(toSessionTokenClaims({ sub: '', iat: 10, exp: 20 })).toBeUndefined();
    expect(toSessionTokenClaims({ sub: 42, iat: 10, exp: 20 })).toBeUndefined();
    expect(toSessionTokenClaims({ sub: 'uuid-1', iat: '10', exp: 20 })).toBeUndefined();
    expect(toSessionTokenClaims({ sub: 'uuid-1', iat: 10 })).toBeUndefined();
  });

  test('tolerates a missing provider claim but keeps sub authoritative', () => {
    expect(toSessionTokenClaims({ sub: 'uuid-1', iat: 10, exp: 20 })).toEqual({
      sub: 'uuid-1',
      provider: undefined,
      iat: 10,
      exp: 20,
    });
  });
});

describe('authenticateSessionRequest', () => {
  test('passes the bearer token to the verifier and returns its claims', async () => {
    const seen: string[] = [];
    const claims = await authenticateSessionRequest('Bearer token-1', async (token) => {
      seen.push(token);
      return { sub: 'uuid-1', provider: 'google', iat: 10, exp: 20 };
    });

    expect(seen).toEqual(['token-1']);
    expect(claims?.sub).toBe('uuid-1');
  });

  test('does not call the verifier when there is no bearer header', async () => {
    let calls = 0;
    const claims = await authenticateSessionRequest(null, async () => {
      calls += 1;
      return { sub: 'uuid-1', iat: 10, exp: 20 };
    });

    expect(calls).toBe(0);
    expect(claims).toBeUndefined();
  });

  test('returns undefined when the verifier rejects the token', async () => {
    const claims = await authenticateSessionRequest('Bearer bad', async () => null);
    expect(claims).toBeUndefined();
  });
});
