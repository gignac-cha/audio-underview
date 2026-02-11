import { createServerLogger } from '@audio-underview/logger';
import {
  type LambdaEvent,
  type LambdaResponse,
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
} from '@audio-underview/function-tools';

interface RunRequestBody {
  type: 'test' | 'run';
  url: string;
  code: string;
}

const logger = createServerLogger({
  defaultContext: {
    module: 'crawler-code-runner-function',
  },
});

const HELP = {
  name: 'crawler-code-runner-function',
  endpoints: [
    { method: 'GET', path: '/', description: 'Show this help' },
    { method: 'GET', path: '/help', description: 'Show this help' },
    {
      method: 'POST',
      path: '/run',
      description: 'Fetch a URL and run code against the response body',
      body: {
        type: "'test' | 'run'",
        url: 'string - The URL to fetch',
        code: 'string - JavaScript function source to execute against the fetched response body',
      },
    },
  ],
};

async function handleRun(body: string | undefined, context: ResponseContext): Promise<LambdaResponse> {
  let parsed: RunRequestBody;
  try {
    parsed = JSON.parse(body ?? '') as RunRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!parsed.type || (parsed.type !== 'test' && parsed.type !== 'run')) {
    return errorResponse('invalid_request', "Field 'type' must be 'test' or 'run'", 400, context);
  }

  if (!parsed.url || typeof parsed.url !== 'string') {
    return errorResponse('invalid_request', "Field 'url' is required and must be a string", 400, context);
  }

  if (!parsed.code || typeof parsed.code !== 'string') {
    return errorResponse('invalid_request', "Field 'code' is required and must be a string", 400, context);
  }

  let targetURL: URL;
  try {
    targetURL = new URL(parsed.url);
  } catch {
    return errorResponse('invalid_request', "Field 'url' must be a valid URL", 400, context);
  }

  let responseText: string;
  try {
    logger.info('Fetching target URL', { url: targetURL.toString() }, { function: 'handleRun' });
    const fetchResponse = await fetch(targetURL.toString());
    responseText = await fetchResponse.text();
    logger.info('Target URL fetched', {
      status: fetchResponse.status,
      contentLength: responseText.length,
    }, { function: 'handleRun' });
  } catch (fetchError) {
    logger.error('Failed to fetch target URL', fetchError, { function: 'handleRun' });
    return errorResponse('fetch_failed', `Failed to fetch URL: ${targetURL.toString()}`, 502, context);
  }

  let result: unknown;
  try {
    const fn = new Function(`return (${parsed.code})`)();
    result = await fn(responseText);
  } catch (executionError) {
    logger.error('Code execution failed', executionError, { function: 'handleRun' });
    const message = executionError instanceof Error
      ? executionError.message
      : 'Unknown execution error';
    return errorResponse('execution_failed', message, 422, context);
  }

  return jsonResponse({ type: parsed.type, result }, 200, context);
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '';
  const allowedOrigins = process.env.ALLOWED_ORIGINS ?? '';

  logger.info('Request received', { method, path, origin }, { function: 'handler' });

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: createCORSHeaders(origin, allowedOrigins, logger),
      body: '',
    };
  }

  if (method === 'HEAD') {
    const headers = createCORSHeaders(origin, allowedOrigins, logger);
    headers['Content-Type'] = 'application/json';
    return { statusCode: 200, headers, body: '' };
  }

  const context: ResponseContext = { origin, allowedOrigins, logger };

  try {
    if (method === 'GET' && (path === '/' || path === '/help')) {
      return jsonResponse(HELP, 200, context);
    }

    if (method === 'POST' && path === '/run') {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
        : event.body;
      return await handleRun(body, context);
    }

    return errorResponse('not_found', 'Endpoint not found', 404, context);
  } catch (error) {
    logger.error('Unhandled function error', error, { function: 'handler' });
    return errorResponse('server_error', 'An unexpected error occurred', 500, context);
  }
}
