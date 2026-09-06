/**
 * 자체 발급 JWT의 issuer/audience — 발급(authentication-worker)과
 * 검증(모든 API worker/function)이 공유하는 계약.
 */
export const JWT_ISSUER = 'audio-underview-authentication-worker';
export const JWT_AUDIENCE = 'audio-underview-api';
