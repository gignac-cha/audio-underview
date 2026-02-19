import {
  kakaoUserResponseSchema,
  parseKakaoUserResponse,
  kakaoOAuthProvider,
  parseKakaoUserFromResponse,
} from './provider.ts';

const validPayload = {
  id: 12345,
  connected_at: '2024-01-01T00:00:00Z',
  properties: {
    nickname: 'PropNickname',
    profile_image: 'https://example.com/prop-photo.jpg',
  },
  kakao_account: {
    profile: {
      nickname: 'AccountNickname',
      profile_image_url: 'https://example.com/account-photo.jpg',
    },
    email: 'user@kakao.com',
    name: 'Kakao User',
  },
};

const baseParameters = {
  clientID: 'test-client-id',
  redirectURI: 'https://example.com/callback',
  responseType: 'code',
  scopes: ['profile_nickname', 'account_email'],
  state: 'random-state',
};

describe('kakaoUserResponseSchema', () => {
  test('parses valid payload', () => {
    expect(kakaoUserResponseSchema.safeParse(validPayload).success).toBe(true);
  });

  test('requires id as number', () => {
    expect(kakaoUserResponseSchema.safeParse({ id: 'string' }).success).toBe(false);
  });

  test('allows minimal payload with just id', () => {
    expect(kakaoUserResponseSchema.safeParse({ id: 1 }).success).toBe(true);
  });
});

describe('kakaoOAuthProvider.buildAuthorizationURL', () => {
  test('uses comma-separated scopes', () => {
    const url = new URL(kakaoOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('scope')).toBe('profile_nickname,account_email');
  });

  test('includes required parameters', () => {
    const url = new URL(kakaoOAuthProvider.buildAuthorizationURL(baseParameters));
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('state')).toBe('random-state');
  });

  test('includes nonce when provided', () => {
    const url = new URL(kakaoOAuthProvider.buildAuthorizationURL({
      ...baseParameters,
      nonce: 'test-nonce',
    }));
    expect(url.searchParams.get('nonce')).toBe('test-nonce');
  });
});

describe('kakaoOAuthProvider.parseCallbackParameters', () => {
  test('parses code and state', () => {
    const result = kakaoOAuthProvider.parseCallbackParameters(
      'https://example.com/callback?code=kakao-code&state=st',
    );
    expect(result.code).toBe('kakao-code');
    expect(result.state).toBe('st');
  });
});

describe('kakaoOAuthProvider.parseUserData', () => {
  test('maps full payload to OAuthUser', () => {
    const user = kakaoOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.id).toBe('12345');
    expect(user.email).toBe('user@kakao.com');
    expect(user.name).toBe('Kakao User');
    expect(user.provider).toBe('kakao');
  });

  test('uses kakao_account profile nickname as fallback', () => {
    const { name: _, ...noName } = validPayload.kakao_account;
    const data = { ...validPayload, kakao_account: noName };
    const user = kakaoOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.name).toBe('AccountNickname');
  });

  test('uses properties nickname as final fallback', () => {
    const data = {
      id: 999,
      properties: { nickname: 'PropUser' },
    };
    const user = kakaoOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.name).toBe('PropUser');
  });

  test('generates fallback email from id', () => {
    const data = { id: 999 };
    const user = kakaoOAuthProvider.parseUserData(data as Record<string, unknown>);
    expect(user.email).toBe('999@kakao.com');
  });

  test('uses profile_image_url from account profile', () => {
    const user = kakaoOAuthProvider.parseUserData(validPayload as Record<string, unknown>);
    expect(user.picture).toBe('https://example.com/account-photo.jpg');
  });
});

describe('parseKakaoUserFromResponse', () => {
  test('delegates to parseUserData', () => {
    const user = parseKakaoUserFromResponse(validPayload as Record<string, unknown>);
    expect(user.provider).toBe('kakao');
  });
});
