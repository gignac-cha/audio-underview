import {
  OAuthFlowError,
  verifyIDToken,
  type OAuthProviderStrategy,
} from '@audio-underview/authentication-core';
import {
  buildStandardAuthorizationURL,
  readString,
  requestToken,
} from '../helpers.ts';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
/** google id_token의 iss는 https 유무 두 형태가 존재한다 */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export const googleStrategy: OAuthProviderStrategy = {
  id: 'google',
  displayName: 'Google',
  capabilities: {
    usesPKCE: true,
    usesNonce: true,
    identitySource: 'id_token',
    requiresEmail: false,
  },
  defaultScopes: ['openid', 'email', 'profile'],
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
      additionalParameters: { access_type: 'online' },
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

  async fetchUser(configuration, tokens, context) {
    if (tokens.idToken === undefined) {
      throw new OAuthFlowError('unauthorized', 'Google did not return an ID token');
    }
    const claims = await verifyIDToken(tokens.idToken, {
      jwksURL: JWKS_ENDPOINT,
      issuers: ISSUERS,
      audience: configuration.clientID,
      expectedNonce: context.expectedNonce,
      fetchImplementation: context.fetchImplementation,
    });

    const subject = readString(claims, 'sub');
    if (subject === undefined) {
      throw new OAuthFlowError('unauthorized', 'Google ID token is missing a subject');
    }
    const email = readString(claims, 'email');
    const name = readString(claims, 'name') ?? email?.split('@')[0] ?? subject;

    return {
      id: subject,
      email: email ?? null,
      name,
      picture: readString(claims, 'picture'),
      provider: 'google',
    };
  },
};
