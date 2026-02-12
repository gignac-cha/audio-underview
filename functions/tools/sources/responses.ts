import type { ErrorResponseBody, LambdaResponse, ResponseContext } from './types.ts';
import { createCORSHeaders } from './cors.ts';

export function jsonResponse(
  data: unknown,
  statusCode: number,
  context: ResponseContext,
): LambdaResponse {
  const headers = createCORSHeaders(context.origin, context.allowedOrigins, context.logger);
  headers['Content-Type'] = 'application/json';

  return {
    statusCode,
    headers,
    body: JSON.stringify(data),
  };
}

export function errorResponse(
  error: string,
  errorDescription: string,
  statusCode: number,
  context: ResponseContext,
): LambdaResponse {
  context.logger.error('Error response', new Error(errorDescription), {
    function: 'errorResponse',
    metadata: { error, statusCode },
  });
  return jsonResponse(
    { error, error_description: errorDescription } satisfies ErrorResponseBody,
    statusCode,
    context,
  );
}
