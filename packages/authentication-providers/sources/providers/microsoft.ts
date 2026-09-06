import {
  decodeJWTPayload,
  OAuthFlowError,
  verifyIDToken,
  type OAuthProviderStrategy,
  type ProviderConfiguration,
} from '@audio-underview/authentication-core';
import {
  buildStandardAuthorizationURL,
  readString,
  requestToken,
} from '../helpers.ts';

/** tenant 미지정 시 개인/조직 계정을 모두 허용하는 공용 tenant */
const DEFAULT_TENANT = 'common';
const ISSUER_PREFIX = 'https://login.microsoftonline.com/';
const ISSUER_SUFFIX = '/v2.0';

const resolveTenant = (configuration: ProviderConfiguration): string =>
  configuration.tenant ?? DEFAULT_TENANT;

/** microsoft endpoint는 tenant 템플릿이다 (스펙 §4.2) */
const buildAuthorizationEndpoint = (tenant: string): string =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
const buildTokenEndpoint = (tenant: string): string =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const buildJWKSEndpoint = (tenant: string): string =>
  `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`;

/**
 * id_token의 iss는 로그인한 계정의 실제 tenant ID(tid)로 채워진다. tenant가
 * 'common'이면 issuer를 사전에 확정할 수 없으므로, iss가 microsoft issuer 형태
 * (`https://login.microsoftonline.com/{tenant}/v2.0`)인지 prefix/suffix로 확인한
 * 뒤 그 값을 기대 issuer로 넘긴다 (verifyIDToken은 정확 일치만 지원).
 * 서명 검증은 이후 verifyIDToken이 수행하므로 여기서의 디코드는 안전하다.
 */
const resolveExpectedIssuers = (tenant: string, idToken: string): string[] => {
  if (tenant !== DEFAULT_TENANT) {
    return [`${ISSUER_PREFIX}${tenant}${ISSUER_SUFFIX}`];
  }
  const payload = decodeJWTPayload(idToken);
  const issuer = payload === undefined ? undefined : readString(payload, 'iss');
  if (
    issuer === undefined ||
    !issuer.startsWith(ISSUER_PREFIX) ||
    !issuer.endsWith(ISSUER_SUFFIX) ||
    issuer.length <= ISSUER_PREFIX.length + ISSUER_SUFFIX.length
  ) {
    throw new OAuthFlowError(
      'unauthorized',
      'Microsoft ID token issuer is not a valid tenant issuer',
    );
  }
  return [issuer];
};

export const microsoftStrategy: OAuthProviderStrategy = {
  id: 'microsoft',
  displayName: 'Microsoft',
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
      endpoint: buildAuthorizationEndpoint(resolveTenant(configuration)),
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
      endpoint: buildTokenEndpoint(resolveTenant(configuration)),
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
      throw new OAuthFlowError('unauthorized', 'Microsoft did not return an ID token');
    }
    const tenant = resolveTenant(configuration);
    const claims = await verifyIDToken(tokens.idToken, {
      jwksURL: buildJWKSEndpoint(tenant),
      issuers: resolveExpectedIssuers(tenant, tokens.idToken),
      audience: configuration.clientID,
      expectedNonce: context.expectedNonce,
      fetchImplementation: context.fetchImplementation,
    });

    const subject = readString(claims, 'sub');
    if (subject === undefined) {
      throw new OAuthFlowError('unauthorized', 'Microsoft ID token is missing a subject');
    }
    // 개인 계정은 email claim 대신 preferred_username에 이메일이 온다 (스펙 §4.4)
    const email = readString(claims, 'email') ?? readString(claims, 'preferred_username');
    const name =
      readString(claims, 'name') ??
      readString(claims, 'given_name') ??
      email?.split('@')[0] ??
      subject;

    return {
      id: subject,
      email: email ?? null,
      name,
      provider: 'microsoft',
    };
  },
};
