import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import { createCodeRunner, MAX_CODE_LENGTH } from './create-code-runner.ts';

interface Environment {
  ALLOWED_ORIGINS: string;
  LOADER: WorkerLoader;
}

interface WebRunRequestBody {
  type: 'web';
  mode: 'test' | 'run';
  url: string;
  code: string;
}

interface DataRunRequestBody {
  type: 'data';
  mode: 'test' | 'run';
  data: unknown;
  code: string;
}

type RunRequestBody = WebRunRequestBody | DataRunRequestBody;

const FETCH_TIMEOUT_MILLISECONDS = 10_000;

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
      description: 'Run code against a fetched URL response (web) or provided data (data)',
      body: {
        type: "'web' | 'data'",
        mode: "'test' | 'run'",
        url: "string - The URL to fetch (required for type 'web')",
        data: "unknown - The data to process (required for type 'data')",
        code: 'string - JavaScript function source to execute against the input',
      },
    },
  ],
};

function validateRunRequestBody(raw: unknown): RunRequestBody | string {
  if (raw == null || typeof raw !== 'object') {
    return 'Request body must be a JSON object';
  }
  const object = raw as Record<string, unknown>;

  if (object.type !== 'web' && object.type !== 'data') {
    return "Field 'type' must be 'web' or 'data'";
  }

  if (object.mode !== 'test' && object.mode !== 'run') {
    return "Field 'mode' must be 'test' or 'run'";
  }

  if (typeof object.code !== 'string') {
    return "Field 'code' is required and must be a string";
  }

  if (object.type === 'web') {
    if (typeof object.url !== 'string') {
      return "Field 'url' is required and must be a string when type is 'web'";
    }
    return {
      type: 'web',
      mode: object.mode as 'test' | 'run',
      url: object.url as string,
      code: object.code as string,
    };
  }

  // type === 'data'
  if (!('data' in object)) {
    return "Field 'data' is required when type is 'data'";
  }
  return {
    type: 'data',
    mode: object.mode as 'test' | 'run',
    data: object.data,
    code: object.code as string,
  };
}

async function handleRun(
  request: Request,
  environment: Environment,
  context: ResponseContext,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  const validated = validateRunRequestBody(raw);
  if (typeof validated === 'string') {
    return errorResponse('invalid_request', validated, 400, context);
  }

  const parsed = validated;

  if (parsed.code.length > MAX_CODE_LENGTH) {
    return errorResponse('invalid_request', `Field 'code' exceeds maximum length of ${MAX_CODE_LENGTH} characters`, 400, context);
  }

  if (parsed.type === 'web') {
    let targetURL: URL;
    try {
      targetURL = new URL(parsed.url);
    } catch {
      return errorResponse('invalid_request', "Field 'url' must be a valid URL", 400, context);
    }

    let responseText: string;
    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS);
      logger.info('Fetching target URL', { url: targetURL.toString() }, { function: 'handleRun' });
      const fetchResponse = await fetch(targetURL.toString(), { signal });
      responseText = await fetchResponse.text();
      logger.info('Target URL fetched', {
        status: fetchResponse.status,
        contentLength: responseText.length,
      }, { function: 'handleRun' });
    } catch (fetchError) {
      if (fetchError instanceof DOMException && fetchError.name === 'TimeoutError') {
        logger.error('Fetch timed out', { url: targetURL.toString(), timeoutMilliseconds: FETCH_TIMEOUT_MILLISECONDS }, { function: 'handleRun' });
        return errorResponse('fetch_timeout', `Fetch timed out after ${FETCH_TIMEOUT_MILLISECONDS}ms`, 504, context);
      }
      logger.error('Failed to fetch target URL', { error: fetchError, url: targetURL.toString() }, { function: 'handleRun' });
      return errorResponse('fetch_failed', 'Failed to fetch the target URL', 502, context);
    }

    let result: unknown;
    try {
      const runner = createCodeRunner(environment.LOADER, parsed.code);
      result = await runner.execute(responseText);
    } catch (executionError) {
      logger.error('Code execution failed', executionError, { function: 'handleRun' });
      return errorResponse('execution_failed', 'Code execution failed', 422, context);
    }

    // Normalize undefined to null to prevent JSON.stringify field drop
    if (result === undefined) {
      result = null;
    }

    return jsonResponse({ type: parsed.type, mode: parsed.mode, result }, 200, context);
  }

  // type === 'data'
  let result: unknown;
  try {
    const runner = createCodeRunner(environment.LOADER, parsed.code);
    result = await runner.execute(parsed.data);
  } catch (executionError) {
    logger.error('Code execution failed', executionError, { function: 'handleRun' });
    return errorResponse('execution_failed', 'Code execution failed', 422, context);
  }

  // Normalize undefined to null to prevent JSON.stringify field drop
  if (result === undefined) {
    result = null;
  }

  return jsonResponse({ type: parsed.type, mode: parsed.mode, result }, 200, context);
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
