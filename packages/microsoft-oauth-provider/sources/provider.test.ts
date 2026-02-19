import {
  microsoftIDTokenPayloadSchema,
  parseMicrosoftIDTokenPayload,
  microsoftOAuthProvider,
  parseMicrosoftUserFromIDToken,
} from './provider.ts';

const validPayload = {
  sub: 'ms-user-123',
  email: 'user@outlook.com',
  name: 'Test User',
  preferred_username: 'user@outlook.com',
  given_name: 'Test',
  family_name: 'User',
  oid: 'object-id',
  tid: 'tenant-id',
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['openid', 'email', 'profile'],
  state: 'random-state',
};

describe('microsoftIDTokenPayloadSchema', () => {
  test('parses valid payload', () => {
    expect(microsoftIDTokenPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires only sub', () => {
    expect(microsoftIDTokenPayloadSchema.safeParse({ sub: 'abc' }).success).toBe(true);
  });

  test('fails without sub', () => {
    expect(microsoftIDTokenPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('microsoftOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(microsoftOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('includes PKCE when provided', () => {
    const url = new URL(microsoftOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      codeChallenge: 'challenge',
    }));
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
  });
});

describe('microsoftOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = microsoftOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=auth-code&state=st',
    );
    expect(result.code).toBe('auth-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = microsoftOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=Denied',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('Denied');
  });
});

describe('microsoftOAuthProvider.parseUserData', () => {
  test('maps payload to OAuthUser', () => {
    const user = microsoftOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('ms-user-123');
    expect(user.email).toBe('user@outlook.com');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('microsoft');
  });

  test('falls back to preferred_username for email', () => {
    const { email: _, ...noEmail } = validPayload;
    const user = microsoftOAuthProvider.parseUserData(noEmail as Record<string, unknown>);
    expect(user.email).toBe('user@outlook.com');
  });

  test('falls back to given_name then email prefix for name', () => {
    const { name: _, given_name: __, ...minimal } = validPayload;
    const user = microsoftOAuthProvider.parseUserData(minimal as Record<string, unknown>);
    expect(user.name).toBe('user');
  });
});

describe('parseMicrosoftUserFromIDToken', () => {
  test('delegates to parseUserData', () => {
    const user = parseMicrosoftUserFromIDToken(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('microsoft');
  });
});
