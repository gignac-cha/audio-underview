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

const AUTHORIZATION_ENDPOINT = 'https://discord.com/api/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://discord.com/api/oauth2/token';
const USER_INFO_ENDPOINT = 'https://discord.com/api/users/@me';
const AVATAR_CDN_PREFIX = 'https://cdn.discordapp.com/avatars';

export const discordStrategy: OAuthProviderStrategy = {
  id: 'discord',
  displayName: 'Discord',
  capabilities: {
    usesPKCE: false,
    usesNonce: false,
    identitySource: 'user_info_api',
    /** email 없는 계정은 로그인 거부 (스펙 §6 discord) */
    requiresEmail: true,
  },
  defaultScopes: ['identify', 'email'],
  scopeSeparator: ' ',

  buildAuthorizationURL(configuration, parameters) {
    return buildStandardAuthorizationURL({
      endpoint: AUTHORIZATION_ENDPOINT,
      clientID: configuration.clientID,
      redirectURI: parameters.redirectURI,
      scopes: parameters.scopes ?? this.defaultScopes,
      scopeSeparator: this.scopeSeparator,
      state: parameters.state,
      additionalParameters: { prompt: 'consent' },
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
      },
    });
  },

  async fetchUser(_configuration, tokens, context) {
    const payload = await fetchUserInfoJSON(
      USER_INFO_ENDPOINT,
      tokens.accessToken,
      context.fetchImplementation,
    );

    const identifier = readString(payload, 'id');
    if (identifier === undefined) {
      throw new OAuthFlowError('unauthorized', 'Discord user response is missing an id');
    }
    // requiresEmail — email 없는 계정은 가짜 이메일을 만들지 않고 거부한다
    const email = readString(payload, 'email');
    if (email === undefined) {
      throw new OAuthFlowError('unauthorized', 'Discord account has no email address');
    }
    // avatar는 hash만 온다 — 있을 때만 CDN URL로 조립 (스펙 §6 discord)
    const avatarHash = readString(payload, 'avatar');

    return {
      id: identifier,
      email,
      name: readString(payload, 'global_name') ?? readString(payload, 'username') ?? identifier,
      picture:
        avatarHash === undefined
          ? undefined
          : `${AVATAR_CDN_PREFIX}/${identifier}/${avatarHash}.png`,
      provider: 'discord',
    };
  },
};
