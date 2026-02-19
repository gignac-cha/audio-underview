import {
  naverUserResponseSchema,
  parseNaverUserResponse,
  naverOAuthProvider,
  parseNaverUserFromResponse,
} from './provider.ts';

const validPayload = {
  resultcode: '00',
  message: 'success',
  response: {
    id: 'naver-123',
    email: 'user@naver.com',
    name: 'Naver User',
    nickname: 'NaverNick',
    profile_image: 'https://example.com/photo.jpg',
    gender: 'M' as const,
  },
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: [] as string[],
  state: 'random-state',
};

describe('naverUserResponseSchema', () => {
  test('parses valid payload', () => {
    expect(naverUserResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires resultcode, message, response', () => {
    expect(naverUserResponseSchema.safeParse({}).success).toBe(false);
  });

  test('requires response.id', () => {
    const data = { ...validPayload, response: {} };
    expect(naverUserResponseSchema.safeParse(data).success).toBe(false);
  });

  test('validates gender enum', () => {
    const data = { ...validPayload, response: { ...validPayload.response, gender: 'X' } };
    expect(naverUserResponseSchema.safeParse(data).success).toBe(false);
  });

  test('allows valid gender values', () => {
    for (const gender of ['M', 'F', 'U']) {
      const data = { ...validPayload, response: { ...validPayload.response, gender } };
      expect(naverUserResponseSchema.safeParse(data).success).toBe(true);
    }
  });
});

describe('naverOAuthProvider.buildAuthorizationURL', () => {
  test('includes required parameters without scopes', () => {
    const url = new URL(naverOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('naverOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = naverOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=naver-code&state=st',
    );
    expect(result.code).toBe('naver-code');
    expect(result.state).toBe('st');
  });

  test('parses error', () => {
    const result = naverOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?error=access_denied&error_description=Denied',
    );
    expect(result.error).toBe('access_denied');
  });
});

describe('naverOAuthProvider.parseUserData', () => {
  test('maps nested response to OAuthUser', () => {
    const user = naverOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('naver-123');
    expect(user.email).toBe('user@naver.com');
    expect(user.name).toBe('Naver User');
    expect(user.picture).toBe('https://example.com/photo.jpg');
    expect(user.provider).toBe('naver');
  });

  test('falls back to nickname for name', () => {
    const { name: _, ...noName } = validPayload.response;
    const data = { ...validPayload, response: noName };
    const user = naverOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.name).toBe('NaverNick');
  });

  test('returns empty string for missing email', () => {
    const { email: _, ...noEmail } = validPayload.response;
    const data = { ...validPayload, response: noEmail };
    const user = naverOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.email).toBe('');
  });
});

describe('parseNaverUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseNaverUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('naver');
  });
});
