import {
  lineTokenResponseSchema,
  lineProfileResponseSchema,
  lineIDTokenVerificationResponseSchema,
  parseLINETokenResponse,
  parseLINEProfileResponse,
  parseLINEIDTokenVerificationResponse,
  lineOAuthProvider,
  createLINEAuthorizationURL,
  parseLINEUserFromResponse,
} from './provider.ts';

const validTokenPayload = {
  access_token: 'test-line-access-token',
  token_type: 'Bearer',
  expires_in: 2592000,
  id_token: 'test-line-id-token',
  refresh_token: 'test-line-refresh-token',
  scope: 'profile openid email',
};

const validProfilePayload = {
  userId: 'U0123456789abcdef0123456789abcdef',
  displayName: 'LINE User',
  pictureUrl: 'https://profile.line-scdn.net/example',
  statusMessage: 'Hello, LINE',
};

const validVerificationPayload = {
  iss: 'https://access.line.me',
  sub: 'U0123456789abcdef0123456789abcdef',
  aud: 'test-channel-id',
  exp: 1504169092,
  iat: 1504263657,
  amr: ['pwd'],
  name: 'LINE User',
  picture: 'https://profile.line-scdn.net/example',
  email: 'user@example.com',
};

const baseParameters = {
  clientID: 'test-channel-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['profile', 'openid', 'email'],
  state: 'random-state',
};

describe('lineTokenResponseSchema', () => {
  test('parses valid payload', () => {
    expect(lineTokenResponseSchema.safeParse(validTokenPayload).success).toBe(true);
  });

  test('requires access_token', () => {
    const { access_token: _, ...noAccessToken } = validTokenPayload;
    expect(lineTokenResponseSchema.safeParse(noAccessToken).success).toBe(false);
  });

  test('allows a response without id_token', () => {
    const { id_token: _, ...noIDToken } = validTokenPayload;
    expect(lineTokenResponseSchema.safeParse(noIDToken).success).toBe(true);
  });

  test('parseLINETokenResponse throws on an error body', () => {
    expect(() => parseLINETokenResponse({ error: 'invalid_grant' })).toThrow('Invalid LINE token response');
  });
});

describe('lineProfileResponseSchema', () => {
  test('parses valid payload', () => {
    expect(lineProfileResponseSchema.safeParse(validProfilePayload).success).toBe(true);
  });

  test('requires userId and displayName', () => {
    expect(lineProfileResponseSchema.safeParse({}).success).toBe(false);
    expect(lineProfileResponseSchema.safeParse({ ...validProfilePayload, userId: '' }).success).toBe(false);
  });

  test('allows a profile without picture and status message', () => {
    const { pictureUrl: _, statusMessage: __, ...minimal } = validProfilePayload;
    expect(lineProfileResponseSchema.safeParse(minimal).success).toBe(true);
  });

  test('validates pictureUrl format', () => {
    const data = { ...validProfilePayload, pictureUrl: 'not-a-url' };
    expect(lineProfileResponseSchema.safeParse(data).success).toBe(false);
  });

  test('parseLINEProfileResponse throws with the failing path', () => {
    expect(() => parseLINEProfileResponse({ displayName: 'x' })).toThrow('userId');
  });
});

describe('lineIDTokenVerificationResponseSchema', () => {
  test('parses valid payload', () => {
    const result = lineIDTokenVerificationResponseSchema.safeParse(validVerificationPayload);
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('user@example.com');
  });

  test('requires sub', () => {
    const { sub: _, ...noSubject } = validVerificationPayload;
    expect(lineIDTokenVerificationResponseSchema.safeParse(noSubject).success).toBe(false);
  });

  test('allows a payload without email', () => {
    const { email: _, ...noEmail } = validVerificationPayload;
    const result = lineIDTokenVerificationResponseSchema.safeParse(noEmail);
    expect(result.success).toBe(true);
    expect(result.data?.email).toBeUndefined();
  });

  test('drops a malformed email instead of failing the verification', () => {
    const result = lineIDTokenVerificationResponseSchema.safeParse({
      ...validVerificationPayload,
      email: 'not-an-email',
    });
    expect(result.success).toBe(true);
    expect(result.data?.sub).toBe(validVerificationPayload.sub);
    expect(result.data?.email).toBeUndefined();
  });

  test('parseLINEIDTokenVerificationResponse throws on an error body', () => {
    expect(() => parseLINEIDTokenVerificationResponse({
      error: 'invalid_request',
      error_description: 'Invalid IdToken.',
    })).toThrow('Invalid LINE ID token verification response');
  });
});

describe('lineOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(lineOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.origin + url.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-channel-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('scope')).toBe('profile openid email');
  });

  test('separates scopes with %20 as LINE documents', () => {
    const url = lineOAuthProvider.buildAuthorizationURL(baseParameters);
    expect(url).toContain('scope=profile%20openid%20email');
    expect(url).not.toContain('+');
  });

  test('keeps a literal plus sign encoded', () => {
    const url = lineOAuthProvider.buildAuthorizationURL({ ...baseParameters, state: 'a+b' });
    expect(new URL(url).searchParams.get('state')).toBe('a+b');
  });

  test('includes nonce and PKCE parameters when given', () => {
    const url = new URL(lineOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      nonce: 'test-nonce',
      codeChallenge: 'test-challenge',
    }));
    expect(url.searchParams.get('nonce')).toBe('test-nonce');
    expect(url.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('includes additional parameters', () => {
    const url = new URL(lineOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { prompt: 'consent' },
    }));
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('lineOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = lineOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=line-code&state=st',
    );
    expect(result.code).toBe('line-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = lineOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=The+user+has+not+granted+the+requested+permissions',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('The user has not granted the requested permissions');
  });
});

describe('lineOAuthProvider.parseUserData', () => {
  test('maps profile to OAuthUser', () => {
    const user = lineOAuthProvider.parseUserData(validProfilePayload);
    expect(user.id).toBe('U0123456789abcdef0123456789abcdef');
    expect(user.name).toBe('LINE User');
    expect(user.picture).toBe('https://profile.line-scdn.net/example');
    expect(user.provider).toBe('line');
  });

  test('omits email because the profile does not carry one', () => {
    const user = lineOAuthProvider.parseUserData(validProfilePayload);
    expect(user.email).toBeUndefined();
    expect(JSON.parse(JSON.stringify(user))).not.toHaveProperty('email');
  });

  test('leaves picture undefined when the user has none', () => {
    const { pictureUrl: _, ...noPicture } = validProfilePayload;
    const user = lineOAuthProvider.parseUserData(noPicture);
    expect(user.picture).toBeUndefined();
  });

  test('throws on an invalid profile', () => {
    expect(() => lineOAuthProvider.parseUserData({ displayName: 'x' })).toThrow('Invalid LINE profile response');
  });
});

describe('createLINEAuthorizationURL', () => {
  test('defaults to code flow with profile, openid and email scopes', () => {
    const url = new URL(createLINEAuthorizationURL('test-channel-id', 'https://example.com/callback', 'st'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('profile openid email');
    expect(url.searchParams.get('client_id')).toBe('test-channel-id');
    expect(url.searchParams.has('nonce')).toBe(false);
  });

  test('accepts custom scopes and nonce', () => {
    const url = new URL(createLINEAuthorizationURL('test-channel-id', 'https://example.com/callback', 'st', {
      scopes: ['profile'],
      nonce: 'test-nonce',
    }));
    expect(url.searchParams.get('scope')).toBe('profile');
    expect(url.searchParams.get('nonce')).toBe('test-nonce');
  });
});

describe('parseLINEUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseLINEUserFromResponse(validProfilePayload);
    expect(user.provider).toBe('line');
    expect(user.email).toBeUndefined();
  });

  test('adds the verified email when given', () => {
    const user = parseLINEUserFromResponse(validProfilePayload, { email: 'user@example.com' });
    expect(user.email).toBe('user@example.com');
    expect(user.id).toBe('U0123456789abcdef0123456789abcdef');
  });

  test('omits email for an empty value', () => {
    const user = parseLINEUserFromResponse(validProfilePayload, { email: '' });
    expect(user).not.toHaveProperty('email');
  });
});
