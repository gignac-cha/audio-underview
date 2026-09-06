import type { ErrorCode } from '@audio-underview/schemas';

/** Lambda Function URL v2 이벤트 (사용하는 필드만) */
export interface LambdaEvent {
  requestContext: { http: { method: string; path: string } };
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

export interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

export interface ResponseContext {
  origin: string;
  allowedOrigins: string[];
}

export const parseAllowedOrigins = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

/** CORS 규약은 worker와 동일 (스펙 §2.2) — Lambda라 Headers 대신 plain record */
const createCORSHeaders = (context: ResponseContext): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (context.allowedOrigins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (context.origin.length > 0 && context.allowedOrigins.includes(context.origin)) {
    headers['Access-Control-Allow-Origin'] = context.origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  } else {
    return headers;
  }
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
  return headers;
};

export const jsonResponse = (
  data: unknown,
  statusCode: number,
  context: ResponseContext,
  extraHeaders: Record<string, string> = {},
): LambdaResponse => ({
  statusCode,
  headers: {
    ...createCORSHeaders(context),
    'Content-Type': 'application/json',
    ...extraHeaders,
  },
  // 사용자 코드가 undefined를 반환하면 JSON.stringify가 result 키를 생략한다 (계약 — 스펙 §5.1)
  body: JSON.stringify(data),
});

export const errorResponse = (
  error: ErrorCode,
  errorDescription: string,
  statusCode: number,
  context: ResponseContext,
  extraHeaders: Record<string, string> = {},
): LambdaResponse =>
  jsonResponse({ error, error_description: errorDescription }, statusCode, context, extraHeaders);

export const emptyResponse = (statusCode: number, context: ResponseContext): LambdaResponse => ({
  statusCode,
  headers: createCORSHeaders(context),
});
