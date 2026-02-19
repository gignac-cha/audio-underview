import {
  linkedInUserInfoSchema,
  parseLinkedInUserInfo,
  linkedInOAuthProvider,
  parseLinkedInUserFromResponse,
} from './provider.ts';

const validPayload = {
  sub: 'li-user-123',
  email: 'user@linkedin.com',
  email_verified: true,
  name: 'Test User',
  given_name: 'Test',
  family_name: 'User',
  picture: 'https://media.licdn.com/photo.jpg',
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['openid', 'profile', 'email'],
  state: 'random-state',
};

describe('linkedInUserInfoSchema', () => {
  test('parses valid payload', () => {
    expect(linkedInUserInfoSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires sub', () => {
    const { sub: _, ...noSub } = validPayload;
    expect(linkedInUserInfoSchema.safeParse(noSub).success).toBe(false);
  });

  test('allows minimal payload', () => {
    expect(linkedInUserInfoSchema.safeParse({ sub: 'abc' }).success).toBe(true);
  });
});

describe('linkedInOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(linkedInOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('includes nonce when provided', () => {
    const url = new URL(linkedInOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      nonce: 'test-nonce',
    }));
    expect(url.searchParams.get('nonce')).toBe('test-nonce');
  });
});

describe('linkedInOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = linkedInOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=li-code&state=st',
    );
    expect(result.code).toBe('li-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = linkedInOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=user_cancelled_authorize',
    );
    expect(result.error).toBe('user_cancelled_authorize');
  });
});

describe('linkedInOAuthProvider.parseUserData', () => {
  test('maps payload to OAuthUser', () => {
    const user = linkedInOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('li-user-123');
    expect(user.email).toBe('user@linkedin.com');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('linkedin');
  });

  test('falls back to given_name then sub for name', () => {
    const { name: _, given_name: __, ...minimal } = validPayload;
    const user = linkedInOAuthProvider.parseUserData(minimal as Record<string, unknown>);
    expect(user.name).toBe('li-user-123');
  });

  test('sets null email when not provided', () => {
    const { email: _, ...noEmail } = validPayload;
    const user = linkedInOAuthProvider.parseUserData(noEmail as Record<string, unknown>);
    expect(user.email).toBeNull();
  });
});

describe('parseLinkedInUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseLinkedInUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('linkedin');
  });
});
