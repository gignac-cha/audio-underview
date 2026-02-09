import type { Logger } from '@audio-underview/logger';
import type { OAuthErrorResponse } from './types.ts';
import { createCORSHeaders } from './cors.ts';

export function jsonResponse(
  data: unknown,
  status: number,
  origin: string,
  allowedOrigins: string,
  logger: Logger
): Response {
  const headers = createCORSHeaders(origin, allowedOrigins, logger);
  headers.set('Content-Type', 'application/json');

  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(
  error: string,
  errorDescription: string,
  status: number,
  origin: string,
  allowedOrigins: string,
  logger: Logger
): Response {
  logger.error('Error response', new Error(errorDescription), {
    function: 'errorResponse',
    metadata: { error, status },
  });
  return jsonResponse(
    { error, errorDescription } satisfies OAuthErrorResponse,
    status,
    origin,
    allowedOrigins,
    logger
  );
}

export function redirectToFrontendWithError(
  frontendURL: string,
  error: string,
  errorDescription: string
): Response {
  const redirectURL = new URL(frontendURL);
  redirectURL.searchParams.set('error', error);
  redirectURL.searchParams.set('error_description', errorDescription);
  return Response.redirect(redirectURL.toString(), 302);
}
