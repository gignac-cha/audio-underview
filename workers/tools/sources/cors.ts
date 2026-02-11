import type { Logger } from '@audio-underview/logger';
import type { BaseEnvironment } from './types.ts';

export function createCORSHeaders(origin: string, allowedOrigins: string, logger: Logger): Headers {
  const headers = new Headers();

  if (!origin) {
    logger.debug('Empty origin, skipping CORS headers', undefined, { function: 'createCORSHeaders' });
    return headers;
  }

  const origins = allowedOrigins.split(',').map((o) => o.trim());
  const isAllowed = origins.includes(origin) || origins.includes('*');

  if (!isAllowed) {
    logger.debug('Origin not in allowed list', { origin, allowedOrigins }, { function: 'createCORSHeaders' });
    return headers;
  }

  if (origins.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }

  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');

  return headers;
}

export function handleOptions(request: Request, environment: BaseEnvironment, logger: Logger): Response {
  const origin = request.headers.get('Origin') ?? '';
  logger.debug('CORS preflight request', { origin }, { function: 'handleOptions' });
  const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
  return new Response(null, { status: 204, headers });
}
