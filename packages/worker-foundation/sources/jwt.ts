/**
 * 자체 발급 HS256 JWT (WebCrypto).
 *
 * 서명 검증은 `crypto.subtle.verify`(HMAC)로 수행한다 — 문자열 비교가 아니므로
 * timing-safe. 레거시 계약(스펙 §2.3) 유지: 3-part 구조, `sub` 문자열,
 * `iat`/`exp` 숫자, `exp >= now` 아니면 `null`.
 */

export interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
  [claim: string]: unknown;
}

const encoder = new TextEncoder();

const base64URLEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const base64URLDecode = (text: string): Uint8Array | undefined => {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const importHMACKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

export const signJWT = async (payload: JWTPayload, secret: string): Promise<string> => {
  const headerPart = base64URLEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payloadPart = base64URLEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importHMACKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  return `${headerPart}.${payloadPart}.${base64URLEncode(new Uint8Array(signature))}`;
};

export interface VerifyJWTOptions {
  /** 설정 시 `iss` claim이 정확히 일치해야 한다. */
  issuer?: string;
  /** 설정 시 `aud` claim이 정확히 일치해야 한다. */
  audience?: string;
}

export const verifyJWT = async (
  token: string,
  secret: string,
  options: VerifyJWTOptions = {},
): Promise<JWTPayload | null> => {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const signature = base64URLDecode(signaturePart);
  if (signature === undefined) {
    return null;
  }

  const key = await importHMACKey(secret);
  const isValidSignature = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!isValidSignature) {
    return null;
  }

  const payloadBytes = base64URLDecode(payloadPart);
  if (payloadBytes === undefined) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;

  if (typeof candidate.sub !== 'string') {
    return null;
  }
  if (typeof candidate.iat !== 'number' || typeof candidate.exp !== 'number') {
    return null;
  }
  if (candidate.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  if (options.issuer !== undefined && candidate.iss !== options.issuer) {
    return null;
  }
  if (options.audience !== undefined && candidate.aud !== options.audience) {
    return null;
  }

  return candidate as JWTPayload;
};

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUUID = (value: string): boolean => UUID_PATTERN.test(value);
