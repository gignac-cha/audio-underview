import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import { createCodeRunner } from './create-code-runner.ts';

interface Environment {
  ALLOWED_ORIGINS: string;
  LOADER: WorkerLoader;
}

interface RunRequestBody {
  type: 'test' | 'run';
  url: string;
  code: string;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-code-runner-worker',
  },
});

const HELP = {
  name: 'crawler-code-runner-worker',
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

async function handleRun(
  request: Request,
  environment: Environment,
  context: ResponseContext,
): Promise<Response> {
  let body: RunRequestBody;
  try {
    body = await request.json() as RunRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!body.type || (body.type !== 'test' && body.type !== 'run')) {
    return errorResponse('invalid_request', "Field 'type' must be 'test' or 'run'", 400, context);
  }

  if (!body.url || typeof body.url !== 'string') {
    return errorResponse('invalid_request', "Field 'url' is required and must be a string", 400, context);
  }

  if (!body.code || typeof body.code !== 'string') {
    return errorResponse('invalid_request', "Field 'code' is required and must be a string", 400, context);
  }

  let targetURL: URL;
  try {
    targetURL = new URL(body.url);
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
    const runner = createCodeRunner(environment.LOADER, body.code);
    result = await runner.execute(responseText);
  } catch (executionError) {
    logger.error('Code execution failed', executionError, { function: 'handleRun' });
    const message = executionError instanceof Error
      ? executionError.message
      : 'Unknown execution error';
    return errorResponse('execution_failed', message, 422, context);
  }

  return jsonResponse({ type: body.type, result }, 200, context);
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    logger.info('Request received', {
      method: request.method,
      pathname: url.pathname,
      origin,
    }, { function: 'fetch' });

    if (request.method === 'OPTIONS') {
      const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
      return new Response(null, { status: 204, headers });
    }

    if (request.method === 'HEAD') {
      const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
      headers.set('Content-Type', 'application/json');
      return new Response(null, { status: 200, headers });
    }

    const context: ResponseContext = {
      origin,
      allowedOrigins: environment.ALLOWED_ORIGINS,
      logger,
    };

    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
        return jsonResponse(HELP, 200, context);
      }

      if (url.pathname === '/run') {
        if (request.method === 'POST') {
          return await handleRun(request, environment, context);
        }
        const response = errorResponse('method_not_allowed', 'Method not allowed. Use POST for /run', 405, context);
        response.headers.set('Allow', 'POST');
        return response;
      }

      return errorResponse('not_found', 'Endpoint not found', 404, context);
    } catch (error) {
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  },
};
