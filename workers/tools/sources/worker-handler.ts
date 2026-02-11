import type { BaseEnvironment, OAuthWorkerOptions, ResponseContext } from './types.ts';
import { handleOptions } from './cors.ts';
import { jsonResponse, errorResponse } from './responses.ts';

export function createOAuthWorkerHandler<Environment extends BaseEnvironment>(
  options: OAuthWorkerOptions<Environment>
) {
  const { provider, logger, handlers } = options;

  return {
    async fetch(request: Request, environment: Environment): Promise<Response> {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin') ?? environment.FRONTEND_URL;

      logger.info('Request received', {
        method: request.method,
        pathname: url.pathname,
        origin,
      }, { function: 'fetch' });

      if (request.method === 'OPTIONS') {
        return handleOptions(request, environment, logger);
      }

      const context: ResponseContext = {
        origin,
        allowedOrigins: environment.ALLOWED_ORIGINS,
        logger,
      };

      try {
        switch (url.pathname) {
          case '/authorize':
            return await handlers.handleAuthorize(request, environment);

          case '/callback':
            return await handlers.handleCallback(request, environment);

          case '/health':
            logger.debug('Health check requested', undefined, { function: 'fetch' });
            return jsonResponse({ status: 'healthy', provider }, 200, context);

          default:
            logger.warn('Unknown endpoint requested', { pathname: url.pathname }, { function: 'fetch' });
            return errorResponse('not_found', 'Endpoint not found', 404, context);
        }
      } catch (error) {
        logger.error('Unhandled worker error', error, { function: 'fetch' });
        return errorResponse('server_error', 'An unexpected error occurred', 500, context);
      }
    },
  };
}
