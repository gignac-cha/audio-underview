import { createServerLogger } from '@audio-underview/logger';
import { createCodeRunner } from './create-code-runner.ts';

interface LambdaEvent {
  version?: string;
  requestContext: {
    http: {
      method: string;
      path: string;
    };
  };
  headers: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

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

function getCORSHeaders(origin: string): Record<string, string> {
  const allowedOrigins = process.env.ALLOWED_ORIGINS ?? '';
  const origins = allowedOrigins.split(',').map((o) => o.trim());
  const isAllowed = origins.includes(origin) || origins.includes('*');

  const headers: Record<string, string> = {};

  if (!origin || !isAllowed) {
    return headers;
  }

  if (origins.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';

  return headers;
}

function jsonResponse(data: unknown, statusCode: number, origin: string): LambdaResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders(origin),
    },
    body: JSON.stringify(data),
  };
}

function errorResponse(
  error: string,
  errorDescription: string,
  statusCode: number,
  origin: string,
): LambdaResponse {
  logger.error('Error response', new Error(errorDescription), {
    function: 'errorResponse',
    metadata: { error, statusCode },
  });
  return jsonResponse({ error, error_description: errorDescription }, statusCode, origin);
}

async function handleRun(body: string | undefined, origin: string): Promise<LambdaResponse> {
  let parsed: RunRequestBody;
  try {
    parsed = JSON.parse(body ?? '') as RunRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, origin);
  }

  if (!parsed.type || (parsed.type !== 'test' && parsed.type !== 'run')) {
    return errorResponse('invalid_request', "Field 'type' must be 'test' or 'run'", 400, origin);
  }

  if (!parsed.url || typeof parsed.url !== 'string') {
    return errorResponse('invalid_request', "Field 'url' is required and must be a string", 400, origin);
  }

  if (!parsed.code || typeof parsed.code !== 'string') {
    return errorResponse('invalid_request', "Field 'code' is required and must be a string", 400, origin);
  }

  let targetURL: URL;
  try {
    targetURL = new URL(parsed.url);
  } catch {
    return errorResponse('invalid_request', "Field 'url' must be a valid URL", 400, origin);
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
    return errorResponse('fetch_failed', `Failed to fetch URL: ${targetURL.toString()}`, 502, origin);
  }

  let result: unknown;
  try {
    const runner = createCodeRunner(parsed.code);
    result = await runner.execute(responseText);
  } catch (executionError) {
    logger.error('Code execution failed', executionError, { function: 'handleRun' });
    const message = executionError instanceof Error
      ? executionError.message
      : 'Unknown execution error';
    return errorResponse('execution_failed', message, 422, origin);
  }

  return jsonResponse({ type: parsed.type, result }, 200, origin);
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const origin = event.headers?.origin ?? event.headers?.Origin ?? '';

  logger.info('Request received', { method, path, origin }, { function: 'handler' });

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: getCORSHeaders(origin),
      body: '',
    };
  }

  if (method === 'HEAD') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...getCORSHeaders(origin),
      },
      body: '',
    };
  }

  try {
    if (method === 'GET' && (path === '/' || path === '/help')) {
      return jsonResponse(HELP, 200, origin);
    }

    if (method === 'POST' && path === '/run') {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
        : event.body;
      return await handleRun(body, origin);
    }

    return errorResponse('not_found', 'Endpoint not found', 404, origin);
  } catch (error) {
    logger.error('Unhandled function error', error, { function: 'handler' });
    return errorResponse('server_error', 'An unexpected error occurred', 500, origin);
  }
}
