import { OAuthFlowError, type OAuthTokenResponse } from '@audio-underview/authentication-core';

/**
 * strategy 공통 헬퍼 — 레거시에서 10개 패키지에 복사-붙여넣기되어 있던
 * authorization URL 조립/token 교환 골격의 단일 구현 (스펙 §4.1).
 */

export interface StandardAuthorizationURLOptions {
  endpoint: string;
  clientID: string;
  redirectURI: string;
  scopes: string[];
  scopeSeparator: ' ' | ',';
  state: string;
  /** github는 response_type 파라미터 자체를 생략한다 */
  includeResponseType?: boolean;
  nonce?: string;
  codeChallenge?: string;
  additionalParameters?: Record<string, string>;
}

export const buildStandardAuthorizationURL = (
  options: StandardAuthorizationURLOptions,
): URL => {
  const url = new URL(options.endpoint);
  url.searchParams.set('client_id', options.clientID);
  url.searchParams.set('redirect_uri', options.redirectURI);
  if (options.includeResponseType ?? true) {
    url.searchParams.set('response_type', 'code');
  }
  if (options.scopes.length > 0) {
    url.searchParams.set('scope', options.scopes.join(options.scopeSeparator));
  }
  url.searchParams.set('state', options.state);
  if (options.nonce !== undefined) {
    url.searchParams.set('nonce', options.nonce);
  }
  if (options.codeChallenge !== undefined) {
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [name, value] of Object.entries(options.additionalParameters ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
};

/**
 * token 응답 정규화. "200이지만 body에 error" 패턴(github 등)도 여기서
 * 일괄 처리한다 — 레거시는 worker마다 검사 여부가 달랐다 (스펙 §10.10).
 */
export const parseTokenResponsePayload = (payload: unknown): OAuthTokenResponse => {
  if (typeof payload !== 'object' || payload === null) {
    throw new OAuthFlowError('unauthorized', 'Token endpoint returned a malformed response');
  }
  const record = payload as Record<string, unknown>;

  if (typeof record.error === 'string') {
    const description =
      typeof record.error_description === 'string' ? record.error_description : record.error;
    throw new OAuthFlowError('unauthorized', `Token exchange failed: ${description}`);
  }
  if (typeof record.access_token !== 'string' || record.access_token.length === 0) {
    throw new OAuthFlowError('unauthorized', 'Token endpoint did not return an access token');
  }

  return {
    accessToken: record.access_token,
    tokenType: typeof record.token_type === 'string' ? record.token_type : undefined,
    expiresIn: typeof record.expires_in === 'number' ? record.expires_in : undefined,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : undefined,
    idToken: typeof record.id_token === 'string' ? record.id_token : undefined,
    scope: typeof record.scope === 'string' ? record.scope : undefined,
  };
};

export interface TokenRequestOptions {
  endpoint: string;
  parameters: Record<string, string>;
  fetchImplementation: typeof fetch;
  /** 'post_body'(기본) | 'get_query'(facebook/naver — 스펙 §6) */
  style?: 'post_body' | 'get_query';
}

export const requestToken = async (options: TokenRequestOptions): Promise<OAuthTokenResponse> => {
  const style = options.style ?? 'post_body';
  let response: Response;

  if (style === 'get_query') {
    const url = new URL(options.endpoint);
    for (const [name, value] of Object.entries(options.parameters)) {
      url.searchParams.set(name, value);
    }
    response = await options.fetchImplementation(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } else {
    response = await options.fetchImplementation(options.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(options.parameters).toString(),
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OAuthFlowError('unauthorized', 'Token endpoint returned a non-JSON response');
  }

  if (!response.ok) {
    const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const description =
      typeof record.error_description === 'string'
        ? record.error_description
        : typeof record.error === 'string'
          ? record.error
          : `HTTP ${response.status}`;
    throw new OAuthFlowError('unauthorized', `Token exchange failed: ${description}`);
  }

  return parseTokenResponsePayload(payload);
};

/** Bearer 인증 REST user-info 호출. */
export const fetchUserInfoJSON = async (
  url: string,
  accessToken: string,
  fetchImplementation: typeof fetch,
): Promise<Record<string, unknown>> => {
  const response = await fetchImplementation(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'audio-underview-authentication-worker',
    },
  });
  if (!response.ok) {
    throw new OAuthFlowError('unauthorized', `User info request failed: HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null) {
    throw new OAuthFlowError('unauthorized', 'User info endpoint returned a malformed response');
  }
  return payload as Record<string, unknown>;
};

export const readString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
