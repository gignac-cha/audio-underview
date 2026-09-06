import { OAuthFlowError } from './types.ts';

/**
 * OIDC ID token 검증 (JWKS).
 *
 * 레거시는 id_token을 디코드만 하고 서명/nonce를 전혀 검증하지 않았다
 * (스펙 §10.6, §10.7). 재작성에서는 provider JWKS로 서명을 검증하고
 * `iss`/`aud`/`exp`/`nonce`를 모두 확인한다.
 */

const base64URLDecode = (text: string): Uint8Array | undefined => {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const decodeJSONPart = (part: string): Record<string, unknown> | undefined => {
  const bytes = base64URLDecode(part);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** 서명 검증 없는 payload 디코드 — 검증이 끝난 토큰의 보조 claims 읽기 전용. */
export const decodeJWTPayload = (token: string): Record<string, unknown> | undefined => {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) {
    return undefined;
  }
  return decodeJSONPart(parts[1]);
};

interface JSONWebKey {
  kid?: string;
  kty: string;
  alg?: string;
  [parameter: string]: unknown;
}

const importVerificationKey = (key: JSONWebKey, algorithm: string): Promise<CryptoKey> => {
  if (algorithm === 'RS256') {
    return crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  }
  if (algorithm === 'ES256') {
    return crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
  }
  throw new OAuthFlowError('unauthorized', `Unsupported ID token algorithm: ${algorithm}`);
};

export interface VerifyIDTokenOptions {
  jwksURL: string;
  /** 허용 issuer (일부 provider는 복수 — 예: google의 https:// 유무) */
  issuers: string[];
  audience: string;
  expectedNonce?: string;
  fetchImplementation?: typeof fetch;
}

export const verifyIDToken = async (
  idToken: string,
  options: VerifyIDTokenOptions,
): Promise<Record<string, unknown>> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new OAuthFlowError('unauthorized', 'ID token is malformed');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJSONPart(headerPart);
  const payload = decodeJSONPart(payloadPart);
  const signature = base64URLDecode(signaturePart);
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new OAuthFlowError('unauthorized', 'ID token is malformed');
  }

  const algorithm = typeof header.alg === 'string' ? header.alg : '';
  const keyID = typeof header.kid === 'string' ? header.kid : undefined;

  const jwksResponse = await fetchImplementation(options.jwksURL);
  if (!jwksResponse.ok) {
    throw new OAuthFlowError('server_error', 'Failed to fetch provider JWKS');
  }
  const jwks = await jwksResponse.json<{ keys?: JSONWebKey[] }>();
  const keys = jwks.keys ?? [];
  const candidates = keyID === undefined ? keys : keys.filter((key) => key.kid === keyID);
  if (candidates.length === 0) {
    throw new OAuthFlowError('unauthorized', 'No matching JWKS key for ID token');
  }

  const data = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const verifyParameters =
    algorithm === 'ES256'
      ? ({ name: 'ECDSA', hash: 'SHA-256' } as const)
      : ({ name: 'RSASSA-PKCS1-v1_5' } as const);

  let isValid = false;
  for (const candidate of candidates) {
    const key = await importVerificationKey(candidate, algorithm);
    if (await crypto.subtle.verify(verifyParameters, key, signature, data)) {
      isValid = true;
      break;
    }
  }
  if (!isValid) {
    throw new OAuthFlowError('unauthorized', 'ID token signature verification failed');
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new OAuthFlowError('unauthorized', 'ID token is expired');
  }
  if (typeof payload.iss !== 'string' || !options.issuers.includes(payload.iss)) {
    throw new OAuthFlowError('unauthorized', 'ID token issuer mismatch');
  }
  const audience = payload.aud;
  const audienceMatches = Array.isArray(audience)
    ? audience.includes(options.audience)
    : audience === options.audience;
  if (!audienceMatches) {
    throw new OAuthFlowError('unauthorized', 'ID token audience mismatch');
  }
  if (options.expectedNonce !== undefined && payload.nonce !== options.expectedNonce) {
    throw new OAuthFlowError('unauthorized', 'ID token nonce mismatch');
  }

  return payload;
};
