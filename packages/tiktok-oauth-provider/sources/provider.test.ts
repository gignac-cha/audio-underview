import {
  tiktokUserResponseSchema,
  parseTikTokUserResponse,
  tiktokOAuthProvider,
  createTikTokAuthorizationURL,
  createTikTokUserInfoURL,
  parseTikTokUserFromResponse,
} from './provider.ts';

const validPayload = {
  data: {
    user: {
      open_id: 'tiktok-open-id-123',
      union_id: 'tiktok-union-id-123',
      avatar_url: 'https://example.com/avatar.jpg',
      display_name: 'TikTok User',
    },
  },
  error: {
    code: 'ok',
    message: '',
    log_id: '20260928000000000000000000000000',
  },
};

const baseParameters = {
  clientID: 'test-client-key',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['user.info.basic'],
  state: 'random-state',
};

describe('tiktokUserResponseSchema', () => {
  test('parses valid payload', () => {
    expect(tiktokUserResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires data.user', () => {
    expect(tiktokUserResponseSchema.safeParse({}).success).toBe(false);
    expect(tiktokUserResponseSchema.safeParse({ data: {} }).success).toBe(false);
  });

  test('requires data.user.open_id', () => {
    const data = { ...validPayload, data: { user: { display_name: 'TikTok User' } } };
    expect(tiktokUserResponseSchema.safeParse(data).success).toBe(false);
  });

  test('rejects an empty open_id', () => {
    const data = { ...validPayload, data: { user: { ...validPayload.data.user, open_id: '' } } };
    expect(tiktokUserResponseSchema.safeParse(data).success).toBe(false);
  });

  test('allows the optional fields to be absent', () => {
    const data = { data: { user: { open_id: 'tiktok-open-id-123' } } };
    expect(tiktokUserResponseSchema.safeParse(data).success).toBe(true);
  });

  test('rejects an avatar_url that is not a URL', () => {
    const data = { ...validPayload, data: { user: { ...validPayload.data.user, avatar_url: 'not-a-url' } } };
    expect(tiktokUserResponseSchema.safeParse(data).success).toBe(false);
  });
});

describe('parseTikTokUserResponse', () => {
  test('returns the parsed payload when error.code is ok', () => {
    expect(parseTikTokUserResponse(validPayload).data.user.open_id).toBe('tiktok-open-id-123');
  });

  test('throws when error.code is not ok', () => {
    const data = {
      ...validPayload,
      error: { code: 'access_token_invalid', message: 'The access token is invalid', log_id: 'log-1' },
    };
    expect(() => parseTikTokUserResponse(data)).toThrow('access_token_invalid');
  });

  test('throws for an invalid payload', () => {
    expect(() => parseTikTokUserResponse({ data: {} })).toThrow('Invalid TikTok user response');
  });
});

describe('tiktokOAuthProvider.buildAuthorizationURL', () => {
  test('uses client_key instead of client_id', () => {
    const url = new URL(tiktokOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('test-client-key');
    expect(url.searchParams.has('client_id')).toBe(false);
  });

  test('includes required parameters', () => {
    const url = new URL(tiktokOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('scope')).toBe('user.info.basic');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('joins multiple scopes with a comma', () => {
    const url = new URL(tiktokOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      scopes: ['user.info.basic', 'user.info.profile'],
    }));
    expect(url.searchParams.get('scope')).toBe('user.info.basic,user.info.profile');
  });

  test('adds additional parameters', () => {
    const url = new URL(tiktokOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { disable_auto_auth: '1' },
    }));
    expect(url.searchParams.get('disable_auto_auth')).toBe('1');
  });
});

describe('createTikTokAuthorizationURL', () => {
  test('defaults to the code response type and the basic scope', () => {
    const url = new URL(createTikTokAuthorizationURL('test-client-key', 'https://example.com/callback', 'st'));
    expect(url.searchParams.get('client_key')).toBe('test-client-key');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user.info.basic');
    expect(url.searchParams.get('state')).toBe('st');
  });
});

describe('createTikTokUserInfoURL', () => {
  test('requests the basic fields by default', () => {
    const url = new URL(createTikTokUserInfoURL());
    expect(url.origin + url.pathname).toBe('https://open.tiktokapis.com/v2/user/info/');
    expect(url.searchParams.get('fields')).toBe('open_id,union_id,avatar_url,display_name');
  });
});

describe('tiktokOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = tiktokOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=tiktok-code&scopes=user.info.basic&state=st',
    );
    expect(result.code).toBe('tiktok-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = tiktokOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=Denied',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('Denied');
  });
});

describe('tiktokOAuthProvider.parseUserData', () => {
  test('maps nested data.user to OAuthUser', () => {
    const user = tiktokOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('tiktok-open-id-123');
    expect(user.name).toBe('TikTok User');
    expect(user.picture).toBe('https://example.com/avatar.jpg');
    expect(user.provider).toBe('tiktok');
  });

  test('leaves email out because TikTok does not provide one', () => {
    const user = tiktokOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect('email' in user).toBe(false);
  });

  test('returns empty string for missing display_name', () => {
    const { display_name: _, ...noDisplayName } = validPayload.data.user;
    const data = { ...validPayload, data: { user: noDisplayName } };
    const user = tiktokOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.name).toBe('');
  });

  test('leaves picture undefined for missing avatar_url', () => {
    const { avatar_url: _, ...noAvatar } = validPayload.data.user;
    const data = { ...validPayload, data: { user: noAvatar } };
    const user = tiktokOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.picture).toBeUndefined();
  });
});

describe('parseTikTokUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseTikTokUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('tiktok');
  });
});
