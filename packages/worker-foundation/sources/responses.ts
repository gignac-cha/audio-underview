import type { ErrorCode } from '@audio-underview/schemas';
import { createCORSHeaders, type ResponseContext } from './cors.ts';

const buildHeaders = (context: ResponseContext, extra?: HeadersInit): Headers => {
  const headers = createCORSHeaders(context);
  headers.set('Content-Type', 'application/json');
  if (extra !== undefined) {
    for (const [name, value] of new Headers(extra)) {
      headers.set(name, value);
    }
  }
  return headers;
};

export const jsonResponse = (
  data: unknown,
  status: number,
  context: ResponseContext,
  extraHeaders?: HeadersInit,
): Response =>
  new Response(JSON.stringify(data), { status, headers: buildHeaders(context, extraHeaders) });

/** 에러 응답 단일 형식: `{ error, error_description }` */
export const errorResponse = (
  error: ErrorCode,
  errorDescription: string,
  status: number,
  context: ResponseContext,
  extraHeaders?: HeadersInit,
): Response =>
  jsonResponse({ error, error_description: errorDescription }, status, context, extraHeaders);

export const methodNotAllowedResponse = (allow: string, context: ResponseContext): Response =>
  errorResponse('method_not_allowed', 'Method not allowed', 405, context, { Allow: allow });

export interface HelpEndpoint {
  method: string;
  path: string;
  description: string;
}

export const helpResponse = (
  name: string,
  endpoints: HelpEndpoint[],
  context: ResponseContext,
): Response => jsonResponse({ name, endpoints }, 200, context);
