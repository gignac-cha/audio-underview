import {
  discordUserDataSchema,
  parseDiscordUserData,
  discordOAuthProvider,
  parseDiscordUserFromResponse,
} from './provider.ts';

const validPayload = {
  id: 'discord-123',
  username: 'testuser',
  discriminator: '0',
  global_name: 'Test User',
  avatar: 'abc123hash',
  email: 'user@example.com',
  verified: true,
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['identify', 'email'],
  state: 'random-state',
};

describe('discordUserDataSchema', () => {
  test('parses valid payload', () => {
    expect(discordUserDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires id, username, discriminator', () => {
    expect(discordUserDataSchema.safeParse({}).success).toBe(false);
  });

  test('allows optional fields', () => {
    expect(discordUserDataSchema.safeParse({
      id: '1', username: 'u', discriminator: '0',
    }).success).toBe(true);
  });
});

describe('discordOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters', () => {
    const url = new URL(discordOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('identify email');
    expect(url.searchParams.get('state')).toBe('random-state');
  });
});

describe('discordOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = discordOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=dc-code&state=st',
    );
    expect(result.code).toBe('dc-code');
    expect(result.state).toBe('st');
  });
});

describe('discordOAuthProvider.parseUserData', () => {
  test('maps payload to OAuthUser', () => {
    const user = discordOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('discord-123');
    expect(user.email).toBe('user@example.com');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('discord');
  });

  test('builds avatar CDN URL', () => {
    const user = discordOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.picture).toBe('https://cdn.discordapp.com/avatars/discord-123/abc123hash.png');
  });

  test('uses username as fallback when global_name is null', () => {
    const user = discordOAuthProvider.parseUserData({
      ...validPayload,
      global_name: null,
    } as Record<string, unknown>);
    expect(user.name).toBe('testuser');
  });

  test('throws when email is missing', () => {
    const { email: _, ...noEmail } = validPayload;
    expect(() => discordOAuthProvider.parseUserData(noEmail as Record<string, unknown>)).toThrow('email is required');
  });

  test('picture is undefined when avatar is null', () => {
    const user = discordOAuthProvider.parseUserData({
      ...validPayload,
      avatar: null,
    } as Record<string, unknown>);
    expect(user.picture).toBeUndefined();
  });
});

describe('parseDiscordUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseDiscordUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('discord');
  });
});
