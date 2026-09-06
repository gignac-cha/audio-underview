import {
  OAuthFlowError,
  signES256JWT,
  verifyIDToken,
  type OAuthProviderStrategy,
  type ProviderConfiguration,
} from '@audio-underview/authentication-core';
import { buildStandardAuthorizationURL, readString, requestToken } from '../helpers.ts';

const AUTHORIZATION_ENDPOINT = 'https://appleid.apple.com/auth/authorize';
const TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
const JWKS_ENDPOINT = 'https://appleid.apple.com/auth/keys';
const ISSUER = 'https://appleid.apple.com';
/** Apple이 허용하는 client secret 최대 수명 — 6개월 (레거시 값 유지) */
const CLIENT_SECRET_TTL_SECONDS = 15_777_000;

/**
 * Apple은 정적 client secret 대신 팀 키로 서명한 ES256 JWT를 요구한다 (스펙 §6 apple).
 */
const generateAppleClientSecret = async (
  configuration: ProviderConfiguration,
): Promise<string> => {
  const apple = configuration.apple;
  if (apple === undefined) {
    throw new OAuthFlowError('server_error', 'Apple signing configuration is missing');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  return signES256JWT({
    keyID: apple.keyID,
    privateKeyPEM: apple.privateKey,
    payload: {
      iss: apple.teamID,
      iat: issuedAt,
      exp: issuedAt + CLIENT_SECRET_TTL_SECONDS,
      aud: ISSUER,
      sub: configuration.clientID,
    },
  });
};

interface AppleUserNamePayload {
  name?: { firstName?: string; lastName?: string; middleName?: string };
}

/** form_post 콜백이 첫 로그인에만 싣는 `user` JSON에서 이름 조립. */
const parseAppleUserName = (payload: string | undefined): string | undefined => {
  if (payload === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload) as AppleUserNamePayload;
    const parts = [parsed.name?.firstName, parsed.name?.middleName, parsed.name?.lastName].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    return parts.length > 0 ? parts.join(' ') : undefined;
  } catch {
    return undefined;
  }
};

export const appleStrategy: OAuthProviderStrategy = {
  id: 'apple',
  displayName: 'Apple',
  capabilities: {
    usesPKCE: false,
    usesNonce: true,
    identitySource: 'id_token',
    requiresEmail: false,
  },
  defaultScopes: ['name', 'email'],
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
      // name/email scope 요청 시 Apple은 form_post를 강제한다
      additionalParameters: { response_mode: 'form_post' },
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
        client_secret: await generateAppleClientSecret(configuration),
        redirect_uri: parameters.redirectURI,
      },
    });
  },

  async fetchUser(configuration, tokens, context) {
    if (tokens.idToken === undefined) {
      throw new OAuthFlowError('unauthorized', 'Apple did not return an ID token');
    }
    const claims = await verifyIDToken(tokens.idToken, {
      jwksURL: JWKS_ENDPOINT,
      issuers: [ISSUER],
      audience: configuration.clientID,
      expectedNonce: context.expectedNonce,
      fetchImplementation: context.fetchImplementation,
    });

    const subject = readString(claims, 'sub');
    if (subject === undefined) {
      throw new OAuthFlowError('unauthorized', 'Apple ID token is missing a subject');
    }
    const email = readString(claims, 'email');
    const name =
      parseAppleUserName(context.appleUserPayload) ?? email?.split('@')[0] ?? subject;

    return {
      id: subject,
      email: email ?? null,
      name,
      provider: 'apple',
    };
  },
};
