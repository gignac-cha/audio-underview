import {
  githubUserDataSchema,
  parseGitHubUserData,
  githubOAuthProvider,
  parseGitHubUserFromResponse,
} from './provider.ts';

const validPayload = {
  id: 12345,
  login: 'testuser',
  email: 'test@example.com',
  name: 'Test User',
  avatar_url: 'https://avatars.githubusercontent.com/u/12345',
  bio: 'Developer',
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['user:email'],
  state: 'random-state',
};

describe('githubUserDataSchema', () => {
  test('parses valid payload', () => {
    expect(githubUserDataSchema.safeParse(validPayload).success).toBe(true);
  });

  test('id must be a number', () => {
    expect(githubUserDataSchema.safeParse({ ...validPayload, id: 'string' }).success).toBe(false);
  });

  test('requires login', () => {
    const { login: _, ...noLogin } = validPayload;
    expect(githubUserDataSchema.safeParse(noLogin).success).toBe(false);
  });

  test('allows null email', () => {
    expect(githubUserDataSchema.safeParse({ ...validPayload, email: null }).success).toBe(true);
  });
});

describe('githubOAuthProvider.buildAuthorizationURL', () => {
  test('does not include response_type', () => {
    const url = new URL(githubOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('response_type')).toBeNull();
  });

  test('includes required parameters', () => {
    const url = new URL(githubOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toBe('user:email');
    expect(url.searchParams.get('state')).toBe('random-state');
  });
});

describe('githubOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = githubOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=gh-code&state=st',
    );
    expect(result.code).toBe('gh-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = githubOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=redirect_uri_mismatch&error_description=Bad+URI',
    );
    expect(result.error).toBe('redirect_uri_mismatch');
    expect(result.errorDescription).toBe('Bad URI');
  });
});

describe('githubOAuthProvider.parseUserData', () => {
  test('converts numeric id to string', () => {
    const user = githubOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('12345');
  });

  test('maps payload to OAuthUser', () => {
    const user = githubOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.email).toBe('test@example.com');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('github');
  });

  test('falls back to login for name when name is null', () => {
    const user = githubOAuthProvider.parseUserData({ ...validPayload, name: null } as Record<string, unknown>);
    expect(user.name).toBe('testuser');
  });

  test('generates noreply email when email is null', () => {
    const user = githubOAuthProvider.parseUserData({ ...validPayload, email: null } as Record<string, unknown>);
    expect(user.email).toBe('testuser@users.noreply.github.com');
  });
});

describe('parseGitHubUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseGitHubUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('github');
  });
});
