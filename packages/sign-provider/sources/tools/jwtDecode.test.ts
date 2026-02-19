import { jwtDecode, getJWTExpiration, isJWTExpired } from './jwtDecode.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function createTestJWT(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

describe('jwtDecode', () => {
  test('decodes valid JWT payload', () => {
    const token = createTestJWT({ sub: '123', email: 'test@example.com' });
    const decoded = jwtDecode(token);
    expect(decoded).toEqual({ sub: '123', email: 'test@example.com' });
  });

  test('throws on invalid format (not 3 parts)', () => {
    expect(() => jwtDecode('not.a.valid.jwt.token')).toThrow('Invalid JWT token format');
    expect(() => jwtDecode('only-one-part')).toThrow('Invalid JWT token format');
  });

  test('throws on non-base64 payload', () => {
    expect(() => jwtDecode('header.!!!invalid!!!.sig')).toThrow();
  });

  test('decodes payload with nested objects', () => {
    const token = createTestJWT({ data: { nested: true } });
    const decoded = jwtDecode<{ data: { nested: boolean } }>(token);
    expect(decoded.data.nested).toBe(true);
  });
});

describe('getJWTExpiration', () => {
  test('returns expiration in milliseconds when exp exists', () => {
    const exp = 1700000000;
    const token = createTestJWT({ exp });
    expect(getJWTExpiration(token)).toBe(exp * 1000);
  });

  test('returns null when exp is missing', () => {
    const token = createTestJWT({ sub: '123' });
    expect(getJWTExpiration(token)).toBeNull();
  });

  test('returns null for invalid token', () => {
    expect(getJWTExpiration('invalid')).toBeNull();
  });
});

describe('isJWTExpired', () => {
  test('returns true for expired token', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const token = createTestJWT({ exp: pastExp });
    expect(isJWTExpired(token)).toBe(true);
  });

  test('returns false for valid (future) token', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = createTestJWT({ exp: futureExp });
    expect(isJWTExpired(token)).toBe(false);
  });

  test('returns false when token has no exp claim', () => {
    const token = createTestJWT({ sub: '123' });
    expect(isJWTExpired(token)).toBe(false);
  });
});
