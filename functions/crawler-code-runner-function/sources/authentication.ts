import { createHmac, timingSafeEqual } from 'node:crypto';
import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';

/**
 * Bearer JWT(HS256) 검증 — worker-foundation `verifyJWT`와 동일한 시맨틱의
 * Node 구현 (worker 패키지는 Cloudflare 타입에 의존하므로 Lambda 번들에서는
 * 자체 구현을 유지한다). 레거시 code-runner는 무인증이었다 — 스펙 §10.5 개선.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const base64URLDecode = (text: string): Buffer | undefined => {
  try {
    return Buffer.from(text, 'base64url');
  } catch {
    return undefined;
  }
};

export const verifyBearerToken = (
  authorizationHeader: string | undefined,
  secret: string,
): { userUUID: string } | undefined => {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    return undefined;
  }
  const token = authorizationHeader.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const provided = base64URLDecode(signaturePart);
  if (provided === undefined) {
    return undefined;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return undefined;
  }

  const payloadBytes = base64URLDecode(payloadPart);
  if (payloadBytes === undefined) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf-8'));
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const claims = payload as Record<string, unknown>;

  if (typeof claims.sub !== 'string' || !UUID_PATTERN.test(claims.sub)) {
    return undefined;
  }
  if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') {
    return undefined;
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  if (claims.iss !== JWT_ISSUER || claims.aud !== JWT_AUDIENCE) {
    return undefined;
  }

  return { userUUID: claims.sub };
};
