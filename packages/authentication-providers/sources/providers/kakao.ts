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

const AUTHORIZATION_ENDPOINT = 'https://kauth.kakao.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://kauth.kakao.com/oauth/token';
const USER_INFO_ENDPOINT = 'https://kapi.kakao.com/v2/user/me';

/** kakao 응답은 kakao_account.profile처럼 깊게 중첩된다 — 안전한 중첩 읽기 */
const readRecord = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
};

export const kakaoStrategy: OAuthProviderStrategy = {
  id: 'kakao',
  displayName: 'Kakao',
  capabilities: {
    usesPKCE: false,
    usesNonce: false,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  defaultScopes: ['profile_nickname', 'profile_image', 'account_email'],
  /** kakao는 scope를 콤마로 구분한다 (스펙 §4.3) */
  scopeSeparator: ',',

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
    return requestToken({
      endpoint: TOKEN_ENDPOINT,
      fetchImplementation,
      parameters: {
        grant_type: 'authorization_code',
        code: parameters.code,
        client_id: configuration.clientID,
        redirect_uri: parameters.redirectURI,
        // kakao의 client_secret은 콘솔에서 활성화한 경우에만 존재 (스펙 §5.7)
        ...(configuration.clientSecret !== undefined && {
          client_secret: configuration.clientSecret,
        }),
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    // kakao의 id는 숫자다 (스펙 §4.4)
    const identifierValue = payload.id;
    if (typeof identifierValue !== 'number') {
      throw new OAuthFlowError('unauthorized', 'Kakao user response is missing an id');
    }
    const identifier = identifierValue.toString();
    const kakaoAccount = readRecord(payload, 'kakao_account');
    const profile = readRecord(kakaoAccount, 'profile');
    const properties = readRecord(payload, 'properties');

    return {
      id: identifier,
      // account_email 동의를 거부할 수 있다 — 레거시 fallback 유지 (스펙 §4.4)
      email: readString(kakaoAccount, 'email') ?? `${identifier}@kakao.com`,
      // account name → profile nickname → properties nickname → 최종 합성 (스펙 §4.4)
      name:
        readString(kakaoAccount, 'name') ??
        readString(profile, 'nickname') ??
        readString(properties, 'nickname') ??
        `KakaoUser${identifier}`,
      picture:
        readString(profile, 'profile_image_url') ?? readString(properties, 'profile_image'),
      provider: 'kakao',
    };
  },
};
