import type { Logger } from '@audio-underview/logger';

export function createCORSHeaders(origin: string, allowedOrigins: string, logger: Logger): Record<string, string> {
  const headers: Record<string, string> = {};

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
    headers['Access-Control-Allow-Origin'] = '*';
  } else {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }

  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';

  return headers;
}
