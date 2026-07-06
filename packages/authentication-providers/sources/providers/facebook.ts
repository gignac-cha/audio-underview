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

const AUTHORIZATION_ENDPOINT = 'https://www.facebook.com/v22.0/dialog/oauth';
const TOKEN_ENDPOINT = 'https://graph.facebook.com/v22.0/oauth/access_token';
const USER_INFO_ENDPOINT = 'https://graph.facebook.com/v22.0/me';
/** Graph API는 받을 필드를 명시해야 한다 */
const USER_INFO_FIELDS = 'id,name,email,first_name,last_name,picture';

/** picture는 `{ picture: { data: { url } } }` 형태로 중첩되어 온다 (스펙 §4.4). */
const readPictureURL = (record: Record<string, unknown>): string | undefined => {
  const picture = record.picture;
  if (typeof picture !== 'object' || picture === null) {
    return undefined;
  }
  const data = (picture as Record<string, unknown>).data;
  if (typeof data !== 'object' || data === null) {
    return undefined;
  }
  return readString(data as Record<string, unknown>, 'url');
};

export const facebookStrategy: OAuthProviderStrategy = {
  id: 'facebook',
  displayName: 'Facebook',
  capabilities: {
    usesPKCE: false,
    usesNonce: false,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  defaultScopes: ['email', 'public_profile'],
  /** facebook은 scope를 콤마로 구분한다 (스펙 §4.3) */
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
    // facebook은 token 교환을 POST body가 아닌 GET query로 받는다 (스펙 §6)
    return requestToken({
      endpoint: TOKEN_ENDPOINT,
      fetchImplementation,
      style: 'get_query',
      parameters: {
        code: parameters.code,
        client_id: configuration.clientID,
        client_secret: configuration.clientSecret ?? '',
        redirect_uri: parameters.redirectURI,
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    // Graph API는 access_token을 query 파라미터로 받는다 — 헬퍼가 실어 보내는
    // Bearer 헤더는 같은 토큰이라 충돌하지 않는다
    const url = new URL(USER_INFO_ENDPOINT);
    url.searchParams.set('fields', USER_INFO_FIELDS);
    url.searchParams.set('access_token', tokens.accessToken);
    const payload = await fetchUserInfoJSON(
      url.toString(),
      tokens.accessToken,
      context.fetchImplementation,
    );

    const identifier = readString(payload, 'id');
    if (identifier === undefined) {
      throw new OAuthFlowError('unauthorized', 'Facebook user response is missing an id');
    }
    const joinedName = [readString(payload, 'first_name'), readString(payload, 'last_name')]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    const name =
      readString(payload, 'name') ?? (joinedName.length > 0 ? joinedName : undefined) ?? identifier;

    return {
      id: identifier,
      // 전화번호 가입 계정 등 email이 없을 수 있다 — 레거시 fallback 유지 (스펙 §4.4)
      email: readString(payload, 'email') ?? `${identifier}@facebook.com`,
      name,
      picture: readPictureURL(payload),
      provider: 'facebook',
    };
  },
};
