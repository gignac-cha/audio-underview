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

const AUTHORIZATION_ENDPOINT = 'https://nid.naver.com/oauth2.0/authorize';
const TOKEN_ENDPOINT = 'https://nid.naver.com/oauth2.0/token';
const USER_INFO_ENDPOINT = 'https://openapi.naver.com/v1/nid/me';
/** naver wrapper 응답의 성공 코드 */
const SUCCESS_RESULT_CODE = '00';

export const naverStrategy: OAuthProviderStrategy = {
  id: 'naver',
  displayName: 'Naver',
  capabilities: {
    usesPKCE: false,
    usesNonce: false,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  /** scope는 naver 개발자 콘솔에서 설정한다 — URL에서 scope 파라미터 생략 (스펙 §4.3) */
  defaultScopes: [],
  scopeSeparator: ' ',

  buildAuthorizationURL(configuration, parameters) {
    return buildStandardAuthorizationURL({
      endpoint: AUTHORIZATION_ENDPOINT,
      clientID: configuration.clientID,
      redirectURI: parameters.redirectURI,
      scopes: parameters.scopes ?? this.defaultScopes,
      scopeSeparator: this.scopeSeparator,
      state: parameters.state,
    });
  },

  async exchangeCode(configuration, parameters, fetchImplementation) {
    // naver는 token 교환을 POST body가 아닌 GET query로 받는다 (스펙 §6)
    return requestToken({
      endpoint: TOKEN_ENDPOINT,
      fetchImplementation,
      style: 'get_query',
      parameters: {
        grant_type: 'authorization_code',
        code: parameters.code,
        client_id: configuration.clientID,
        client_secret: configuration.clientSecret ?? '',
        redirect_uri: parameters.redirectURI,
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    // 응답은 { resultcode, message, response } wrapper다 (스펙 §4.4)
    if (readString(payload, 'resultcode') !== SUCCESS_RESULT_CODE) {
      const message = readString(payload, 'message') ?? 'unknown error';
      throw new OAuthFlowError('unauthorized', `Naver user info request failed: ${message}`);
    }
    const response = payload.response;
    if (typeof response !== 'object' || response === null) {
      throw new OAuthFlowError('unauthorized', 'Naver user response is malformed');
    }
    const record = response as Record<string, unknown>;

    const identifier = readString(record, 'id');
    if (identifier === undefined) {
      throw new OAuthFlowError('unauthorized', 'Naver user response is missing an id');
    }

    return {
      id: identifier,
      // email 비공개 계정이 있다 — 가짜 fallback을 만들지 않고 null 유지 (email nullable 계약)
      email: readString(record, 'email') ?? null,
      name: readString(record, 'name') ?? readString(record, 'nickname') ?? identifier,
      picture: readString(record, 'profile_image'),
      provider: 'naver',
    };
  },
};
