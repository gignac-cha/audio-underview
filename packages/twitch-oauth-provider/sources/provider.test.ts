import {
  twitchTokenResponseSchema,
  twitchUsersResponseSchema,
  parseTwitchTokenResponse,
  parseTwitchUsersResponse,
  twitchOAuthProvider,
  createTwitchAuthorizationURL,
  parseTwitchUserFromResponse,
} from './provider.ts';

const validTokenPayload = {
  access_token: 'test-twitch-access-token',
  expires_in: 14124,
  refresh_token: 'test-twitch-refresh-token',
  scope: ['user:read:email'],
  token_type: 'bearer',
};

const validUser = {
  id: '141981764',
  login: 'twitchdev',
  display_name: 'TwitchDev',
  type: '',
  broadcaster_type: 'partner',
  description: 'Supporting third-party developers building Twitch integrations.',
  profile_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/test-profile_image-300x300.png',
  offline_image_url: 'https://static-cdn.jtvnw.net/jtv_user_pictures/test-channel_offline_image-1920x1080.png',
  view_count: 5980557,
  email: 'not-real@email.com',
  created_at: '2016-12-14T20:32:28Z',
};

const validPayload = { data: [validUser] };

function payloadWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { data: [{ ...validUser, ...overrides }] };
}

function payloadWithout(field: keyof typeof validUser): Record<string, unknown> {
  const { [field]: _, ...rest } = validUser;
  return { data: [rest] };
}

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['user:read:email'],
  state: 'random-state',
};

describe('twitchTokenResponseSchema', () => {
  test('parses valid payload', () => {
    expect(twitchTokenResponseSchema.safeParse(validTokenPayload).success).toBe(true);
  });

  test('requires access_token', () => {
    const { access_token: _, ...noAccessToken } = validTokenPayload;
    expect(twitchTokenResponseSchema.safeParse(noAccessToken).success).toBe(false);
  });

  test('takes scope as an array, the way Twitch returns it', () => {
    expect(twitchTokenResponseSchema.safeParse({ ...validTokenPayload, scope: 'user:read:email' }).success).toBe(false);
  });

  test('parseTwitchTokenResponse throws on an error body', () => {
    expect(() => parseTwitchTokenResponse({ status: 400, message: 'Invalid authorization code' }))
      .toThrow('Invalid Twitch token response');
  });
});

describe('twitchUsersResponseSchema', () => {
  test('parses valid payload', () => {
    expect(twitchUsersResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires data', () => {
    expect(twitchUsersResponseSchema.safeParse({}).success).toBe(false);
  });

  test('requires id and login', () => {
    expect(twitchUsersResponseSchema.safeParse(payloadWithout('id')).success).toBe(false);
    expect(twitchUsersResponseSchema.safeParse(payloadWithout('login')).success).toBe(false);
    expect(twitchUsersResponseSchema.safeParse(payloadWith({ id: '' })).success).toBe(false);
  });

  test('allows a user without email', () => {
    const result = twitchUsersResponseSchema.safeParse(payloadWithout('email'));
    expect(result.success).toBe(true);
    expect(result.data?.data[0].email).toBeUndefined();
  });

  test('allows the null email Twitch returns for an unverified address', () => {
    const result = twitchUsersResponseSchema.safeParse(payloadWith({ email: null }));
    expect(result.success).toBe(true);
    expect(result.data?.data[0].email).toBeNull();
  });

  test('drops a malformed email instead of failing', () => {
    const result = twitchUsersResponseSchema.safeParse(payloadWith({ email: 'not-an-email' }));
    expect(result.success).toBe(true);
    expect(result.data?.data[0].id).toBe('141981764');
    expect(result.data?.data[0].email).toBeUndefined();
  });

  test('drops a profile image URL that does not parse', () => {
    const result = twitchUsersResponseSchema.safeParse(payloadWith({ profile_image_url: '' }));
    expect(result.success).toBe(true);
    expect(result.data?.data[0].profile_image_url).toBeUndefined();
  });

  test('parseTwitchUsersResponse throws with the failing path', () => {
    expect(() => parseTwitchUsersResponse({ data: [{ login: 'x' }] })).toThrow('data.0.id');
  });
});

describe('twitchOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(twitchOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.origin + url.pathname).toBe('https://id.twitch.tv/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user:read:email');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('joins several scopes with a space', () => {
    const url = new URL(twitchOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      scopes: ['user:read:email', 'openid'],
    }));
    expect(url.searchParams.get('scope')).toBe('user:read:email openid');
  });

  test('includes additional parameters', () => {
    const url = new URL(twitchOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      additionalParameters: { force_verify: 'true' },
    }));
    expect(url.searchParams.get('force_verify')).toBe('true');
  });
});

describe('twitchOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = twitchOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=twitch-code&scope=user%3Aread%3Aemail&state=st',
    );
    expect(result.code).toBe('twitch-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = twitchOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=The+user+denied+you+access&state=st',
    );
    expect(result.error).toBe('access_denied');
    expect(result.errorDescription).toBe('The user denied you access');
  });
});

describe('twitchOAuthProvider.parseUserData', () => {
  test('maps the first Get Users entry to OAuthUser', () => {
    const user = twitchOAuthProvider.parseUserData(validPayload);
    expect(user.id).toBe('141981764');
    expect(user.email).toBe('not-real@email.com');
    expect(user.name).toBe('TwitchDev');
    expect(user.picture).toBe(validUser.profile_image_url);
    expect(user.provider).toBe('twitch');
  });

  test('falls back to login for name', () => {
    expect(twitchOAuthProvider.parseUserData(payloadWithout('display_name')).name).toBe('twitchdev');
    expect(twitchOAuthProvider.parseUserData(payloadWith({ display_name: '' })).name).toBe('twitchdev');
  });

  test('omits email when the response carries none', () => {
    const user = twitchOAuthProvider.parseUserData(payloadWithout('email'));
    expect(user).not.toHaveProperty('email');
  });

  test('omits email when Twitch returns null for an unverified address', () => {
    const user = twitchOAuthProvider.parseUserData(payloadWith({ email: null }));
    expect(user).not.toHaveProperty('email');
  });

  test('omits email for an empty value', () => {
    const user = twitchOAuthProvider.parseUserData(payloadWith({ email: '' }));
    expect(user).not.toHaveProperty('email');
  });

  test('leaves picture undefined when the user has none', () => {
    const user = twitchOAuthProvider.parseUserData(payloadWithout('profile_image_url'));
    expect(user.picture).toBeUndefined();
  });

  test('throws when data is empty', () => {
    expect(() => twitchOAuthProvider.parseUserData({ data: [] })).toThrow('data is empty');
  });

  test('throws on an invalid response', () => {
    expect(() => twitchOAuthProvider.parseUserData({})).toThrow('Invalid Twitch user response');
  });
});

describe('createTwitchAuthorizationURL', () => {
  test('defaults to code flow with the user:read:email scope', () => {
    const url = new URL(createTwitchAuthorizationURL('test-client-id', 'https://example.com/callback', 'st'));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('user:read:email');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toBe('st');
  });

  test('accepts custom scopes', () => {
    const url = new URL(createTwitchAuthorizationURL('test-client-id', 'https://example.com/callback', 'st', {
      scopes: ['openid'],
    }));
    expect(url.searchParams.get('scope')).toBe('openid');
  });
});

describe('parseTwitchUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseTwitchUserFromResponse(validPayload);
    expect(user.provider).toBe('twitch');
    expect(user.id).toBe('141981764');
  });

  test('throws when data is empty', () => {
    expect(() => parseTwitchUserFromResponse({ data: [] })).toThrow('data is empty');
  });
});
