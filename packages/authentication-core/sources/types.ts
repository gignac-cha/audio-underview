import type { OAuthProviderID, OAuthUser } from '@audio-underview/schemas';

/**
 * provider별 자격 증명/설정. 단일 authentication-worker의 환경변수에서 조립된다.
 * apple은 client secret이 정적 값이 아니라 ES256 JWT라서 별도 필드를 가진다.
 */
export interface ProviderConfiguration {
  clientID: string;
  clientSecret?: string;
  /** microsoft 전용 — 기본 'common' */
  tenant?: string;
  /** apple 전용 — client secret JWT 생성 재료 */
  apple?: {
    teamID: string;
    keyID: string;
    privateKey: string;
  };
}

export interface AuthorizationURLParameters {
  redirectURI: string;
  state: string;
  scopes?: string[];
  nonce?: string;
  codeChallenge?: string;
}

export interface CodeExchangeParameters {
  code: string;
  redirectURI: string;
  codeVerifier?: string;
}

export interface OAuthTokenResponse {
  accessToken: string;
  tokenType?: string;
  expiresIn?: number;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
}

/**
 * provider strategy — 10개 provider의 가변 축 전부 (스펙 §11).
 *
 * 공통 흐름(state/PKCE/nonce 관리, KV, 사용자 upsert, code 발급)은 worker가
 * 소유하고, strategy는 provider별 차이만 구현한다.
 */
export interface OAuthProviderStrategy {
  readonly id: OAuthProviderID;
  readonly displayName: string;
  readonly capabilities: {
    /** true면 authorize에 code_challenge(S256), 교환에 code_verifier를 사용 (x는 필수) */
    usesPKCE: boolean;
    /** true면 authorize에 nonce를 실어 보내고 id_token의 nonce claim을 검증 */
    usesNonce: boolean;
    identitySource: 'id_token' | 'user_info_api';
    /** true면 email 없는 계정 로그인을 거부 (discord) */
    requiresEmail: boolean;
  };
  readonly defaultScopes: string[];
  /** facebook/kakao는 ',' — 나머지는 ' ' */
  readonly scopeSeparator: ' ' | ',';

  buildAuthorizationURL(
    configuration: ProviderConfiguration,
    parameters: AuthorizationURLParameters,
  ): URL;

  exchangeCode(
    configuration: ProviderConfiguration,
    parameters: CodeExchangeParameters,
    fetchImplementation: typeof fetch,
  ): Promise<OAuthTokenResponse>;

  /**
   * 정규화된 사용자 획득.
   * - `id_token` 계열: JWKS 서명 검증 + nonce 검증 후 claims 파싱 (verifyIDToken 사용)
   * - `user_info_api` 계열: REST 호출 후 응답 파싱
   */
  fetchUser(
    configuration: ProviderConfiguration,
    tokens: OAuthTokenResponse,
    context: FetchUserContext,
  ): Promise<OAuthUser>;
}

export interface FetchUserContext {
  fetchImplementation: typeof fetch;
  /** authorize 때 state에 저장했던 nonce — id_token nonce claim과 대조 */
  expectedNonce?: string;
  /** apple form_post가 첫 로그인에만 전달하는 `user` JSON (이름 정보) */
  appleUserPayload?: string;
}

export class OAuthFlowError extends Error {
  readonly errorCode: 'invalid_request' | 'invalid_state' | 'unauthorized' | 'server_error';

  constructor(errorCode: OAuthFlowError['errorCode'], message: string) {
    super(message);
    this.name = 'OAuthFlowError';
    this.errorCode = errorCode;
  }
}
