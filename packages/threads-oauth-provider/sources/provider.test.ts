import {
  THREADS_AUTHORIZATION_ENDPOINT,
  THREADS_TOKEN_ENDPOINT,
  THREADS_USER_INFO_ENDPOINT,
} from './configuration.ts';
import {
  threadsTokenResponseSchema,
  parseThreadsTokenResponse,
  threadsUserResponseSchema,
  parseThreadsUserResponse,
  threadsOAuthProvider,
  createThreadsAuthorizationURL,
  parseThreadsUserFromResponse,
} from './provider.ts';

const validPayload = {
  id: '1234567',
  username: 'threadsapitestuser',
  name: 'Threads API Test User',
  threads_profile_picture_url: 'https://scontent.example.com/profile.jpg',
  threads_biography: 'This is my Threads bio.',
  is_verified: false,
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['threads_basic'],
  state: 'random-state',
};

describe('configuration', () => {
  test('uses the hosts Meta currently documents', () => {
    expect(new URL(THREADS_AUTHORIZATION_ENDPOINT).origin).toBe('https://threads.com');
    expect(new URL(THREADS_TOKEN_ENDPOINT).origin).toBe('https://graph.threads.com');
    expect(THREADS_USER_INFO_ENDPOINT).toBe('https://graph.threads.net/v1.0/me');
  });
});

describe('threadsTokenResponseSchema', () => {
  test('parses a documented token response', () => {
    const data = { access_token: 'test-access-token', token_type: 'bearer', user_id: 17841405793187218 };
    expect(threadsTokenResponseSchema.safeParse(data).success).toBe(true);
  });

  test('accepts user_id as a string', () => {
    const data = { access_token: 'test-access-token', user_id: '17841405793187218' };
    expect(threadsTokenResponseSchema.safeParse(data).success).toBe(true);
  });

  test('requires access_token', () => {
    const rejected = {
      error_type: 'OAuthException',
      code: 400,
      error_message: 'Matching code was not found or was already used',
    };
    expect(threadsTokenResponseSchema.safeParse(rejected).success).toBe(false);
  });

  test('parseThreadsTokenResponse throws on an invalid response', () => {
    expect(() => parseThreadsTokenResponse({ access_token: '' })).toThrow('Invalid Threads token response');
  });
});

describe('threadsUserResponseSchema', () => {
  test('parses valid payload', () => {
    expect(threadsUserResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires id', () => {
    const { id: _, ...noID } = validPayload;
    expect(threadsUserResponseSchema.safeParse(noID).success).toBe(false);
  });

  test('requires username', () => {
    const { username: _, ...noUsername } = validPayload;
    expect(threadsUserResponseSchema.safeParse(noUsername).success).toBe(false);
  });

  test('allows a missing name and picture', () => {
    const { name: _, threads_profile_picture_url: __, ...minimal } = validPayload;
    expect(threadsUserResponseSchema.safeParse(minimal).success).toBe(true);
  });

  test('rejects a picture that is not a URL', () => {
    const data = { ...validPayload, threads_profile_picture_url: 'not-a-url' };
    expect(threadsUserResponseSchema.safeParse(data).success).toBe(false);
  });

  test('parseThreadsUserResponse throws on an invalid response', () => {
    expect(() => parseThreadsUserResponse({})).toThrow('Invalid Threads user response');
  });
});

describe('threadsOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(threadsOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.origin + url.pathname).toBe('https://threads.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('threads_basic');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('joins several scopes with commas', () => {
    const url = new URL(threadsOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      scopes: ['threads_basic', 'threads_content_publish'],
    }));
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
  });

  test('includes additional parameters', () => {
    const url = new URL(threadsOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { custom: 'value' },
    }));
    expect(url.searchParams.get('custom')).toBe('value');
  });
});

describe('createThreadsAuthorizationURL', () => {
  test('defaults to response_type=code and scope=threads_basic', () => {
    const url = new URL(createThreadsAuthorizationURL('test-client-id', 'https://example.com/callback', 'st'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('threads_basic');
    expect(url.searchParams.get('state')).toBe('st');
  });

  test('accepts custom scopes', () => {
    const url = new URL(createThreadsAuthorizationURL('test-client-id', 'https://example.com/callback', 'st', {
      scopes: ['threads_basic', 'threads_manage_insights'],
    }));
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_manage_insights');
  });
});

describe('threadsOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = threadsOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=threads-code&state=st',
    );
    expect(result.code).toBe('threads-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = threadsOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_reason=user_denied&error_description=The+user+denied+your+request',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('The user denied your request');
  });
});

describe('threadsOAuthProvider.parseUserData', () => {
  test('maps response to OAuthUser', () => {
    const user = threadsOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('1234567');
    expect(user.name).toBe('Threads API Test User');
    expect(user.picture).toBe('https://scontent.example.com/profile.jpg');
    expect(user.provider).toBe('threads');
  });

  test('falls back to username for name', () => {
    const { name: _, ...noName } = validPayload;
    const user = threadsOAuthProvider.parseUserData(noName as Record<string, unknown>);
    expect(user.name).toBe('threadsapitestuser');
  });

  test('leaves email out instead of inventing one', () => {
    const user = threadsOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect('email' in user).toBe(false);
    expect(user.email).toBeUndefined();
  });

  test('leaves picture undefined when Threads has none', () => {
    const { threads_profile_picture_url: _, ...noPicture } = validPayload;
    const user = threadsOAuthProvider.parseUserData(noPicture as Record<string, unknown>);
    expect(user.picture).toBeUndefined();
  });
});

describe('parseThreadsUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseThreadsUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('threads');
  });
});
