import {
  facebookUserDataSchema,
  parseFacebookUserData,
  facebookOAuthProvider,
  parseFacebookUserFromResponse,
} from './provider.ts';

const validPayload = {
  id: 'fb-123',
  email: 'user@example.com',
  name: 'Test User',
  first_name: 'Test',
  last_name: 'User',
  picture: {
    data: {
      url: 'https://example.com/photo.jpg',
      width: 50,
      height: 50,
      is_silhouette: false,
    },
  },
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['email', 'public_profile'],
  state: 'random-state',
};

describe('facebookUserDataSchema', () => {
  test('parses valid payload', () => {
    expect(facebookUserDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test('fails on missing id', () => {
    const { id: _, ...noID } = validPayload;
    expect(facebookUserDataSchema.safeParse(noID).success).toBe(false);
  });

  test('allows optional fields to be omitted', () => {
    expect(facebookUserDataSchema.safeParse({ id: '123' }).success).toBe(true);
  });
});

describe('facebookOAuthProvider.buildAuthorizationURL', () => {
  test('uses comma-separated scopes', () => {
    const url = new URL(facebookOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('scope')).toBe('email,public_profile');
  });

  test('includes required parameters', () => {
    const url = new URL(facebookOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toBe('random-state');
  });
});

describe('facebookOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = facebookOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=fb-code&state=st',
    );
    expect(result.code).toBe('fb-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = facebookOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied',
    );
    expect(result.error).toBe('access_denied');
  });
});

describe('facebookOAuthProvider.parseUserData', () => {
  test('maps payload to OAuthUser', () => {
    const user = facebookOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('fb-123');
    expect(user.email).toBe('user@example.com');
    expect(user.name).toBe('Test User');
    expect(user.picture).toBe('https://example.com/photo.jpg');
    expect(user.provider).toBe('facebook');
  });

  test('generates fallback email from id', () => {
    const { email: _, ...noEmail } = validPayload;
    const user = facebookOAuthProvider.parseUserData(noEmail as Record<string, unknown>);
    expect(user.email).toBe('fb-123@facebook.com');
  });

  test('builds name from first_name and last_name', () => {
    const { name: _, ...noName } = validPayload;
    const user = facebookOAuthProvider.parseUserData(noName as Record<string, unknown>);
    expect(user.name).toBe('Test User');
  });
});

describe('parseFacebookUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseFacebookUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('facebook');
  });
});
