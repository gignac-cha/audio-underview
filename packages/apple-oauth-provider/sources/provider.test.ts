import {
  appleIDTokenPayloadSchema,
  appleUserNameSchema,
  parseAppleIDTokenPayload,
  appleOAuthProvider,
  parseAppleUserFromIDToken,
} from './provider.ts';

const validPayload = {
  sub: 'apple-user-123',
  email: 'user@privaterelay.appleid.com',
  email_verified: true,
  is_private_email: true,
  real_user_status: 2,
};

const baseParameters = {
  clientID: 'com.example.app',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['name', 'email'],
  state: 'random-state',
};

describe('appleIDTokenPayloadSchema', () => {
  test('parses valid payload', () => {
    const result = appleIDTokenPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test('fails on missing sub', () => {
    const { sub: _, ...noSub } = validPayload;
    expect(appleIDTokenPayloadSchema.safeParse(noSub).success).toBe(false);
  });

  test('allows email_verified as string or boolean', () => {
    expect(appleIDTokenPayloadSchema.safeParse({ ...validPayload, email_verified: 'true' }).success).toBe(true);
    expect(appleIDTokenPayloadSchema.safeParse({ ...validPayload, email_verified: true }).success).toBe(true);
  });
});

describe('appleUserNameSchema', () => {
  test('parses full name', () => {
    const result = appleUserNameSchema.safeParse({ firstName: 'John', lastName: 'Doe' });
    expect(result.success).toBe(true);
  });

  test('allows all fields optional', () => {
    expect(appleUserNameSchema.safeParse({}).success).toBe(true);
  });
});

describe('appleOAuthProvider.buildAuthorizationURL', () => {
  test('includes response_mode defaulting to query', () => {
    const url = new URL(appleOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('response_mode')).toBe('query');
  });

  test('includes required parameters', () => {
    const url = new URL(appleOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('com.example.app');
    expect(url.searchParams.get('scope')).toBe('name email');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('supports custom response_mode', () => {
    const url = new URL(appleOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { response_mode: 'form_post' },
    }));
    expect(url.searchParams.get('response_mode')).toBe('form_post');
  });
});

describe('appleOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state from query', () => {
    const result = appleOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=auth-code&state=st1',
    );
    expect(result.code).toBe('auth-code');
    expect(result.state).toBe('st1');
  });

  test('parses error', () => {
    const result = appleOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=user_cancelled_authorize',
    );
    expect(result.error).toBe('user_cancelled_authorize');
  });
});

describe('appleOAuthProvider.parseUserData', () => {
  test('uses email prefix as name fallback', () => {
    const user = appleOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('apple-user-123');
    expect(user.name).toBe('user');
    expect(user.provider).toBe('apple');
  });
});

describe('parseAppleUserFromIDToken', () => {
  test('uses AppleUserName when provided', () => {
    const user = parseAppleUserFromIDToken(
      validPayload as Record<string, unknown>,
      { firstName: 'Jane', lastName: 'Doe' },
    );
    expect(user.name).toBe('Jane Doe');
  });

  test('falls back to email prefix without userName', () => {
    const user = parseAppleUserFromIDToken(validPayload as Record<string, unknown>);
    expect(user.name).toBe('user');
  });
});
