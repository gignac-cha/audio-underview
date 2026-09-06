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

const AUTHORIZATION_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';
/** OIDC userinfo endpoint — id_token 대신 이 REST 응답으로 사용자 확정 (스펙 §4.4) */
const USER_INFO_ENDPOINT = 'https://api.linkedin.com/v2/userinfo';

export const linkedinStrategy: OAuthProviderStrategy = {
  id: 'linkedin',
  displayName: 'LinkedIn',
  capabilities: {
    usesPKCE: true,
    // authorize URL에는 nonce를 싣지만 사용자 확정은 userinfo 경유
    usesNonce: true,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  defaultScopes: ['openid', 'profile', 'email'],
  scopeSeparator: ' ',

  buildAuthorizationURL(configuration, parameters) {
    return buildStandardAuthorizationURL({
      endpoint: AUTHORIZATION_ENDPOINT,
      clientID: configuration.clientID,
      redirectURI: parameters.redirectURI,
      scopes: parameters.scopes ?? this.defaultScopes,
      scopeSeparator: this.scopeSeparator,
      state: parameters.state,
      nonce: parameters.nonce,
      codeChallenge: parameters.codeChallenge,
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
        client_secret: configuration.clientSecret ?? '',
        redirect_uri: parameters.redirectURI,
        ...(parameters.codeVerifier !== undefined && { code_verifier: parameters.codeVerifier }),
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    const subject = readString(payload, 'sub');
    if (subject === undefined) {
      throw new OAuthFlowError('unauthorized', 'LinkedIn user response is missing a subject');
    }

    return {
      id: subject,
      email: readString(payload, 'email') ?? null,
      name: readString(payload, 'name') ?? readString(payload, 'given_name') ?? subject,
      picture: readString(payload, 'picture'),
      provider: 'linkedin',
    };
  },
};
