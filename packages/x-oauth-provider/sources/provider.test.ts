import {
  xUserDataSchema,
  parseXUserData,
  xOAuthProvider,
  parseXUserFromResponse,
} from './provider.ts';

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

describe('xUserDataSchema', () => {
  test('parses valid payload', () => {
    expect(xUserDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires data.id', () => {
    const { id: _, ...noID } = validPayload.data;
    expect(xUserDataSchema.safeParse({ data: noID }).success).toBe(false);
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
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('users.read tweet.read');
    expect(url.searchParams.get('state')).toBe('random-state');
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
  test('sets email to null', () => {
    const user = xOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.email).toBeNull();
  });

  test('maps payload to OAuthUser', () => {
    const user = xOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('x-123');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('x');
  });
});

describe('parseXUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseXUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('x');
  });
});
