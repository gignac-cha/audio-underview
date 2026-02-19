import {
  parseOAuthUser,
  parseStoredAuthenticationData,
  isAuthenticationExpired,
  createStoredAuthenticationData,
} from './user.ts';
import type { OAuthUser, StoredAuthenticationData } from './user.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const validUser: OAuthUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/avatar.png',
  provider: 'google',
};

describe('parseOAuthUser', () => {
  test('parses valid user data', () => {
    const result = parseOAuthUser(validUser);
    expect(result.id).toBe('user-123');
    expect(result.email).toBe('test@example.com');
    expect(result.name).toBe('Test User');
    expect(result.provider).toBe('google');
  });

  test('throws on missing required id field', () => {
    const { id: _, ...noID } = validUser;
    expect(() => parseOAuthUser(noID)).toThrow('Invalid OAuth user data');
  });

  test('throws on missing required name field', () => {
    const { name: _, ...noName } = validUser;
    expect(() => parseOAuthUser(noName)).toThrow('Invalid OAuth user data');
  });

  test('throws on invalid email format', () => {
    expect(() => parseOAuthUser({ ...validUser, email: 'not-an-email' })).toThrow('Invalid OAuth user data');
  });

  test('allows null email', () => {
    const result = parseOAuthUser({ ...validUser, email: null });
    expect(result.email).toBeNull();
  });

  test('allows missing email', () => {
    const { email: _, ...noEmail } = validUser;
    const result = parseOAuthUser(noEmail);
    expect(result.email).toBeUndefined();
  });

  test('validates provider enum', () => {
    expect(() => parseOAuthUser({ ...validUser, provider: 'invalid' })).toThrow('Invalid OAuth user data');
  });

  test('parses all valid providers', () => {
    const providers = ['google', 'apple', 'microsoft', 'facebook', 'github', 'x', 'linkedin', 'discord', 'kakao', 'naver'];
    for (const provider of providers) {
      const result = parseOAuthUser({ ...validUser, provider });
      expect(result.provider).toBe(provider);
    }
  });
});

describe('parseStoredAuthenticationData', () => {
  test('parses valid stored data', () => {
    const data = {
      user: validUser,
      credential: 'token-123',
      expiresAt: Date.now() + 60000,
    };
    const result = parseStoredAuthenticationData(data);
    expect(result).not.toBeNull();
    expect(result!.credential).toBe('token-123');
  });

  test('returns null for invalid data', () => {
    expect(parseStoredAuthenticationData({})).toBeNull();
  });

  test('returns null for missing credential', () => {
    expect(parseStoredAuthenticationData({ user: validUser, expiresAt: 9999999 })).toBeNull();
  });
});

describe('isAuthenticationExpired', () => {
  test('returns true for past timestamp', () => {
    const data: StoredAuthenticationData = {
      user: validUser,
      credential: 'token',
      expiresAt: Date.now() - 1000,
    };
    expect(isAuthenticationExpired(data)).toBe(true);
  });

  test('returns false for future timestamp', () => {
    const data: StoredAuthenticationData = {
      user: validUser,
      credential: 'token',
      expiresAt: Date.now() + 60000,
    };
    expect(isAuthenticationExpired(data)).toBe(false);
  });
});

describe('createStoredAuthenticationData', () => {
  test('creates data with default session duration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000);
    const result = createStoredAuthenticationData(validUser, 'token-abc');

    expect(result.user).toEqual(validUser);
    expect(result.credential).toBe('token-abc');
    expect(result.expiresAt).toBe(1000000 + 24 * 60 * 60 * 1000);
  });

  test('creates data with custom session duration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000);
    const result = createStoredAuthenticationData(validUser, 'token', 5000);

    expect(result.expiresAt).toBe(1005000);
  });
});
