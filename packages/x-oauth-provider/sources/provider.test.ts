import {
  xUserDataSchema,
  parseXUserData,
  xOAuthProvider,
  createXAuthorizationURL,
  parseXUserFromResponse,
} from './provider.ts';
import {
  X_AUTHORIZATION_ENDPOINT,
  X_TOKEN_ENDPOINT,
  X_REVOKE_ENDPOINT,
  X_USER_INFO_ENDPOINT,
  X_DEFAULT_SCOPES,
  X_USER_FIELDS,
} from './configuration.ts';

const validPayload = {
  data: {
    id: 'x-123',
    username: 'testuser',
    name: 'Test User',
    profile_image_url: 'https://pbs.twimg.com/profile_images/123/photo.jpg',
    description: 'Bio text',
  },
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['users.read', 'tweet.read'],
  state: 'random-state',
  codeChallenge: 'pkce-challenge',
};

describe('X configuration', () => {
  test('points at the x.com and api.x.com OAuth 2.0 endpoints', () => {
    expect(X_AUTHORIZATION_ENDPOINT).toBe('https://x.com/i/oauth2/authorize');
    expect(X_TOKEN_ENDPOINT).toBe('https://api.x.com/2/oauth2/token');
    expect(X_REVOKE_ENDPOINT).toBe('https://api.x.com/2/oauth2/revoke');
    expect(X_USER_INFO_ENDPOINT).toBe('https://api.x.com/2/users/me');
  });

  test('requests the email scope and no refresh token by default', () => {
    expect(X_DEFAULT_SCOPES).toEqual(['users.read', 'tweet.read', 'users.email']);
    expect(X_DEFAULT_SCOPES).not.toContain('offline.access');
  });

  test('asks for the profile image and the confirmed email', () => {
    expect(X_USER_FIELDS).toEqual(['profile_image_url', 'confirmed_email']);
  });
});

describe('xUserDataSchema', () => {
  test('parses valid payload', () => {
    expect(xUserDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires data.id', () => {
    const { id: _, ...noID } = validPayload.data;
    expect(xUserDataSchema.safeParse({ data: noID }).success).toBe(false);
  });

  test('allows optional confirmed_email', () => {
    const withEmail = { data: { ...validPayload.data, confirmed_email: 'test@example.com' } };
    const result = xUserDataSchema.safeParse(withEmail);
    expect(result.success).toBe(true);
    expect(result.data?.data.confirmed_email).toBe('test@example.com');
  });

  test('drops a malformed confirmed_email instead of failing', () => {
    const result = xUserDataSchema.safeParse({
      data: { ...validPayload.data, confirmed_email: 'not-an-email' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.data.confirmed_email).toBeUndefined();
  });

  test('allows optional public_metrics', () => {
    const withMetrics = {
      data: {
        ...validPayload.data,
        public_metrics: { followers_count: 100, tweet_count: 50 },
      },
    };
    expect(xUserDataSchema.safeParse(withMetrics).success).toBe(true);
  });
});

describe('xOAuthProvider.buildAuthorizationURL', () => {
  test('requires PKCE codeChallenge', () => {
    const { codeChallenge: _, ...noChallenge } = baseParameters;
    expect(() => xOAuthProvider.buildAuthorizationURL(noChallenge)).toThrow('PKCE');
  });

  test('includes PKCE parameters', () => {
    const url = new URL(xOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('includes required parameters', () => {
    const url = new URL(xOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('users.read tweet.read');
    expect(url.searchParams.get('state')).toBe('random-state');
  });
});

describe('createXAuthorizationURL', () => {
  test('builds an x.com URL with the default scopes and an S256 challenge', () => {
    const url = new URL(createXAuthorizationURL(
      'test-client-id',
      'https://example.com/callback',
      'random-state',
      'pkce-challenge',
    ));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('scope')).toBe('users.read tweet.read users.email');
    expect(url.searchParams.get('code_challenge')).toBe('pkce-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('honours explicit scopes', () => {
    const url = new URL(createXAuthorizationURL(
      'test-client-id',
      'https://example.com/callback',
      'random-state',
      'pkce-challenge',
      { scopes: ['users.read'] },
    ));
    expect(url.searchParams.get('scope')).toBe('users.read');
  });
});

describe('xOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = xOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=x-code&state=st',
    );
    expect(result.code).toBe('x-code');
    expect(result.state).toBe('st');
  });
});

describe('xOAuthProvider.parseUserData', () => {
  test('omits email when X returns no confirmed_email', () => {
    const user = xOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user).not.toHaveProperty('email');
  });

  test('maps confirmed_email to email', () => {
    const user = xOAuthProvider.parseUserData({
      data: { ...validPayload.data, confirmed_email: 'test@example.com' },
    });
    expect(user.email).toBe('test@example.com');
  });

  test('omits email when confirmed_email is malformed', () => {
    const user = xOAuthProvider.parseUserData({
      data: { ...validPayload.data, confirmed_email: 'not-an-email' },
    });
    expect(user).not.toHaveProperty('email');
  });

  test('maps payload to OAuthUser', () => {
    const user = xOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('x-123');
    expect(user.name).toBe('Test User');
    expect(user.picture).toBe('https://pbs.twimg.com/profile_images/123/photo.jpg');
    expect(user.provider).toBe('x');
  });

  test('throws on a response without data', () => {
    expect(() => xOAuthProvider.parseUserData({ errors: [{ title: 'Forbidden' }] })).toThrow('Invalid X user data');
  });
});

describe('parseXUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseXUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('x');
  });
});
