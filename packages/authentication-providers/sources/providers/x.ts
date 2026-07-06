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

const AUTHORIZATION_ENDPOINT = 'https://twitter.com/i/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.twitter.com/2/oauth2/token';
const USER_INFO_ENDPOINT = 'https://api.twitter.com/2/users/me';

export const xStrategy: OAuthProviderStrategy = {
  id: 'x',
  displayName: 'X',
  capabilities: {
    /** x는 PKCE(S256)가 필수다 (스펙 §4.3) */
    usesPKCE: true,
    usesNonce: false,
    identitySource: 'user_info_api',
    requiresEmail: false,
  },
  defaultScopes: ['users.read', 'tweet.read', 'offline.access'],
  scopeSeparator: ' ',

  buildAuthorizationURL(configuration, parameters) {
    if (parameters.codeChallenge === undefined) {
      throw new OAuthFlowError('invalid_request', 'X requires PKCE — code challenge is missing');
    }
    return buildStandardAuthorizationURL({
      endpoint: AUTHORIZATION_ENDPOINT,
      clientID: configuration.clientID,
      redirectURI: parameters.redirectURI,
      scopes: parameters.scopes ?? this.defaultScopes,
      scopeSeparator: this.scopeSeparator,
      state: parameters.state,
      codeChallenge: parameters.codeChallenge,
    });
  },

  async exchangeCode(configuration, parameters, fetchImplementation) {
    if (parameters.codeVerifier === undefined) {
      throw new OAuthFlowError('invalid_request', 'X requires PKCE — code verifier is missing');
    }
    // confidential client — client_id/client_secret을 POST body에 싣는다
    return requestToken({
      endpoint: TOKEN_ENDPOINT,
      fetchImplementation,
      parameters: {
        grant_type: 'authorization_code',
        code: parameters.code,
        client_id: configuration.clientID,
        client_secret: configuration.clientSecret ?? '',
        redirect_uri: parameters.redirectURI,
        code_verifier: parameters.codeVerifier,
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    // 응답은 { data: { id, username, name, profile_image_url } } wrapper다 (스펙 §4.4)
    const data = payload.data;
    if (typeof data !== 'object' || data === null) {
      throw new OAuthFlowError('unauthorized', 'X user response is malformed');
    }
    const record = data as Record<string, unknown>;

    const identifier = readString(record, 'id');
    if (identifier === undefined) {
      throw new OAuthFlowError('unauthorized', 'X user response is missing an id');
    }

    return {
      id: identifier,
      // x는 email을 제공하지 않는다 — 항상 null (스펙 §4.4)
      email: null,
      name: readString(record, 'name') ?? readString(record, 'username') ?? identifier,
      picture: readString(record, 'profile_image_url'),
      provider: 'x',
    };
  },
};
