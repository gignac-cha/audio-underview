import { describe, it, expect } from 'vitest';
import { signJWT, verifyJWT, type JWTPayload } from '../sources/jwt.ts';

const TEST_SECRET = 'test-jwt-secret-key-for-testing-only';

describe('JWT sign and verify', () => {
  it('round-trips: sign then verify returns original payload', async () => {
    const payload: JWTPayload = {
      sub: '00000000-0000-0000-0000-000000000001',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };

    const token = await signJWT(payload, TEST_SECRET);
    const result = await verifyJWT(token, TEST_SECRET);

    expect(result).not.toBeNull();
    expect(result!.sub).toBe(payload.sub);
    expect(result!.iat).toBe(payload.iat);
    expect(result!.exp).toBe(payload.exp);
  });

  it('returns null for wrong secret', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };

    const token = await signJWT(payload, TEST_SECRET);
    const result = await verifyJWT(token, 'wrong-secret');

    expect(result).toBeNull();
  });

  it('returns null for expired token', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    };

    const token = await signJWT(payload, TEST_SECRET);
    const result = await verifyJWT(token, TEST_SECRET);

    expect(result).toBeNull();
  });

  it('returns null for malformed token', async () => {
    expect(await verifyJWT('not-a-jwt', TEST_SECRET)).toBeNull();
    expect(await verifyJWT('a.b', TEST_SECRET)).toBeNull();
    expect(await verifyJWT('a.b.c.d', TEST_SECRET)).toBeNull();
    expect(await verifyJWT('', TEST_SECRET)).toBeNull();
  });

  it('returns null for tampered payload', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };

    const token = await signJWT(payload, TEST_SECRET);
    const parts = token.split('.');

    // Tamper with the payload
    const tamperedPayload = btoa(JSON.stringify({ ...payload, sub: 'attacker' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const result = await verifyJWT(tamperedToken, TEST_SECRET);
    expect(result).toBeNull();
  });

  it('preserves custom claims in payload', async () => {
    const payload: JWTPayload = {
      sub: 'user-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
      role: 'admin',
      provider: 'google',
    };

    const token = await signJWT(payload, TEST_SECRET);
    const result = await verifyJWT(token, TEST_SECRET);

    expect(result).not.toBeNull();
    expect(result!.role).toBe('admin');
    expect(result!.provider).toBe('google');
  });
});
