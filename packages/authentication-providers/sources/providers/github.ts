import {
  OAuthFlowError,
  type OAuthProviderStrategy,
} from '@audio-underview/authentication-core';
import {
  buildStandardAuthorizationURL,
  fetchUserInfoJSON,
  readString,
  requestToken,
} from '../helpers.ts';

const AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const USER_INFO_ENDPOINT = 'https://api.github.com/user';
const USER_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';

/**
 * 프로필에 공개 email이 없으면 /user/emails에서 primary+verified 항목을 찾는다
 * (스펙 §6 github). 조회 실패(scope 미허용 등)는 noreply fallback으로 이어지므로
 * 로그인 자체를 막지 않는다.
 */
const fetchPrimaryVerifiedEmail = async (
  accessToken: string,
  fetchImplementation: typeof fetch,
): Promise<string | undefined> => {
  let payload: Record<string, unknown>;
  try {
    payload = await fetchUserInfoJSON(USER_EMAILS_ENDPOINT, accessToken, fetchImplementation);
  } catch {
    return undefined;
  }
  // 응답은 배열이다 — fetchUserInfoJSON의 object 검사를 배열도 통과한다
  if (!Array.isArray(payload)) {
    return undefined;
  }
  for (const entry of payload as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.primary === true && record.verified === true) {
      return readString(record, 'email');
    }
  }
  return undefined;
};

export const githubStrategy: OAuthProviderStrategy = {
  id: 'github',
  displayName: 'GitHub',
  capabilities: {
    usesPKCE: false,
    usesNonce: false,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  defaultScopes: ['user:email'],
  scopeSeparator: ' ',

  buildAuthorizationURL(configuration, parameters) {
    return buildStandardAuthorizationURL({
      endpoint: AUTHORIZATION_ENDPOINT,
      clientID: configuration.clientID,
      redirectURI: parameters.redirectURI,
      scopes: parameters.scopes ?? this.defaultScopes,
      scopeSeparator: this.scopeSeparator,
      state: parameters.state,
      // github는 response_type 파라미터를 아예 쓰지 않는다 (스펙 §4.3)
      includeResponseType: false,
    });
  },

  async exchangeCode(configuration, parameters, fetchImplementation) {
    // github는 Accept: application/json이 없으면 form-encoded로 응답한다 —
    // requestToken이 이 헤더를 항상 실어 보낸다 (스펙 §6)
    return requestToken({
      endpoint: TOKEN_ENDPOINT,
      fetchImplementation,
      parameters: {
        code: parameters.code,
        client_id: configuration.clientID,
        client_secret: configuration.clientSecret ?? '',
        redirect_uri: parameters.redirectURI,
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    // User-Agent 헤더는 github API 필수 — fetchUserInfoJSON이 이미 넣는다
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    // github의 id는 숫자다 (스펙 §4.4)
    const identifier = payload.id;
    if (typeof identifier !== 'number') {
      throw new OAuthFlowError('unauthorized', 'GitHub user response is missing an id');
    }
    const login = readString(payload, 'login');
    const email =
      readString(payload, 'email') ??
      (await fetchPrimaryVerifiedEmail(tokens.accessToken, context.fetchImplementation)) ??
      `${login ?? identifier.toString()}@users.noreply.github.com`;

    return {
      id: identifier.toString(),
      email,
      name: readString(payload, 'name') ?? login ?? identifier.toString(),
      picture: readString(payload, 'avatar_url'),
      provider: 'github',
    };
  },
};
