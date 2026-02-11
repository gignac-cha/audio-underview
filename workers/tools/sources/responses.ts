import type { Logger } from '@audio-underview/logger';
import type { OAuthErrorResponse, ResponseContext } from './types.ts';
import { createCORSHeaders } from './cors.ts';

export function jsonResponse(
  data: unknown,
  status: number,
  context: ResponseContext
): Response {
  const headers = createCORSHeaders(context.origin, context.allowedOrigins, context.logger);
  headers.set('Content-Type', 'application/json');

  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(
  error: string,
  errorDescription: string,
  status: number,
  context: ResponseContext
): Response {
  context.logger.error('Error response', new Error(errorDescription), {
    function: 'errorResponse',
    metadata: { error, status },
  });
  return jsonResponse(
    { error, error_description: errorDescription } satisfies OAuthErrorResponse,
    status,
    context
  );
}

export function redirectToFrontendWithError(
  frontendURL: string,
  error: string,
  errorDescription: string,
  logger: Logger
): Response {
  try {
    const redirectURL = new URL(frontendURL);
    redirectURL.searchParams.set('error', error);
    redirectURL.searchParams.set('error_description', errorDescription);
    return Response.redirect(redirectURL.toString(), 302);
  } catch (urlError) {
    logger.error('Invalid frontend URL for redirect', urlError, {
      function: 'redirectToFrontendWithError',
      metadata: { frontendURL, error, errorDescription },
    });
    return new Response(
      JSON.stringify({ error, error_description: errorDescription }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
