/**
 * CORS 규약 (전 서비스 공통 — 스펙 §2.2):
 * - `ALLOWED_ORIGINS`는 콤마 구분 문자열.
 * - origin이 목록에 있으면 `Allow-Origin: <origin>` + `Allow-Credentials: true` + `Vary: Origin`.
 * - `*` 포함 시 `Allow-Origin: *` (credentials 없음).
 * - origin 미허용/빈 값이면 CORS 헤더 자체를 생략.
 */

export interface CORSOptions {
  /** 기본 'GET, POST, OPTIONS' — manager 계열은 'GET, POST, PUT, DELETE, OPTIONS' */
  allowMethods?: string;
  /** 기본 'Content-Type' — 인증 API는 'Content-Type, Authorization' */
  allowHeaders?: string;
}

export interface ResponseContext {
  origin: string;
  allowedOrigins: string[];
  cors?: CORSOptions;
}

export const parseAllowedOrigins = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

export const createCORSHeaders = (context: ResponseContext): Headers => {
  const headers = new Headers();
  const allowMethods = context.cors?.allowMethods ?? 'GET, POST, OPTIONS';
  const allowHeaders = context.cors?.allowHeaders ?? 'Content-Type';

  if (context.allowedOrigins.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (context.origin.length > 0 && context.allowedOrigins.includes(context.origin)) {
    headers.set('Access-Control-Allow-Origin', context.origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  } else {
    return headers;
  }

  headers.set('Access-Control-Allow-Methods', allowMethods);
  headers.set('Access-Control-Allow-Headers', allowHeaders);
  return headers;
};
