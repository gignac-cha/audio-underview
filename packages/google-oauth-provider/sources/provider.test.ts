import {
  googleIDTokenPayloadSchema,
  parseGoogleIDTokenPayload,
  googleOAuthProvider,
  parseGoogleUserFromIDToken,
} from './provider.ts';

const validPayload = {
  sub: '123456789',
  email: 'user@gmail.com',
  name: 'Test User',
  email_verified: true,
  picture: 'https://example.com/photo.jpg',
  given_name: 'Test',
  family_name: 'User',
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['openid', 'email', 'profile'],
  state: 'random-state',
};

describe('googleIDTokenPayloadSchema', () => {
  test('parses valid payload', () => {
    const result = googleIDTokenPayloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test('fails on missing sub', () => {
    const { sub: _, ...noSub } = validPayload;
    const result = googleIDTokenPayloadSchema.safeParse(noSub);
    expect(result.success).toBe(false);
  });

  test('allows optional fields to be omitted', () => {
    const minimal = { sub: '123', email: 'user@test.com', name: 'User' };
    const result = googleIDTokenPayloadSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});

describe('parseGoogleIDTokenPayload', () => {
  test('returns parsed payload for valid data', () => {
    const result = parseGoogleIDTokenPayload(validPayload);
    expect(result.sub).toBe('123456789');
  });

  test('throws on invalid data', () => {
    expect(() => parseGoogleIDTokenPayload({})).toThrow('Invalid Google ID token payload');
  });
});

describe('googleOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(googleOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('includes nonce when provided', () => {
    const url = new URL(googleOAuthProvider.buildAuthorizationURL({ ...baseParameters, nonce: 'test-nonce' }));
    expect(url.searchParams.get('nonce')).toBe('test-nonce');
  });

  test('includes PKCE code challenge', () => {
    const url = new URL(googleOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      codeChallenge: 'challenge123',
    }));
    expect(url.searchParams.get('code_challenge')).toBe('challenge123');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('sets access_type for id_token response type', () => {
    const url = new URL(googleOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      responseType: 'id_token token',
    }));
    expect(url.searchParams.get('access_type')).toBe('online');
  });
});

describe('googleOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state from query', () => {
    const result = googleOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=auth-code&state=my-state',
    );
    expect(result.code).toBe('auth-code');
    expect(result.state).toBe('my-state');
  });

  test('parses error from query', () => {
    const result = googleOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=User+denied',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('User denied');
  });

  test('parses id_token from hash fragment', () => {
    const result = googleOAuthProvider.parseCallbackParameters(
      'https://example.com/callback#id_token=jwt-token&access_token=at-token&state=s1',
    );
    expect(result.idToken).toBe('jwt-token');
    expect(result.accessToken).toBe('at-token');
    expect(result.state).toBe('s1');
  });
});

describe('googleOAuthProvider.parseUserData', () => {
  test('maps Google payload to OAuthUser', () => {
    const user = googleOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('123456789');
    expect(user.email).toBe('user@gmail.com');
    expect(user.name).toBe('Test User');
    expect(user.picture).toBe('https://example.com/photo.jpg');
    expect(user.provider).toBe('google');
  });
});

describe('parseGoogleUserFromIDToken', () => {
  test('delegates to parseUserData', () => {
    const user = parseGoogleUserFromIDToken(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('google');
  });
});
