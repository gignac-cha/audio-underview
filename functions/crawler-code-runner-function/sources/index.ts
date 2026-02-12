import { createServerLogger } from '@audio-underview/logger';
import {
  type LambdaEvent,
  type LambdaResponse,
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
} from '@audio-underview/function-tools';
import { createContext, Script } from 'node:vm';
import { lookup } from 'node:dns/promises';

interface RunRequestBody {
  type: 'test' | 'run';
  url: string;
  code: string;
}

const FETCH_TIMEOUT_MILLISECONDS = 10_000;
const CODE_EXECUTION_TIMEOUT_MILLISECONDS = 5_000;
const MAX_CODE_LENGTH = 10_000;

const BLOCKED_IP_RANGES = [
  /^127\./, // loopback IPv4
  /^10\./, // RFC1918 Class A
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 Class B
  /^192\.168\./, // RFC1918 Class C
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^::1$/, // loopback IPv6
  /^fe80:/i, // link-local IPv6
  /^fc00:/i, // unique local IPv6
  /^fd[0-9a-f]{2}:/i, // unique local IPv6
  /^::ffff:127\./i, // IPv4-mapped loopback
  /^::ffff:10\./i, // IPv4-mapped RFC1918
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i, // IPv4-mapped RFC1918
  /^::ffff:192\.168\./i, // IPv4-mapped RFC1918
  /^::ffff:169\.254\./i, // IPv4-mapped link-local
];

function isBlockedIP(ip: string): boolean {
  return BLOCKED_IP_RANGES.some((range) => range.test(ip));
}

async function validateTargetURL(targetURL: URL, context: ResponseContext): Promise<LambdaResponse | null> {
  const { logger } = context;

  if (targetURL.protocol !== 'http:' && targetURL.protocol !== 'https:') {
    logger.error('Rejected non-HTTP protocol', { protocol: targetURL.protocol, url: targetURL.toString() }, { function: 'validateTargetURL' });
    return errorResponse('invalid_request', `Protocol '${targetURL.protocol}' is not allowed. Only http: and https: are permitted`, 400, context);
  }

  try {
    const result = await lookup(targetURL.hostname, { all: true });
    const addresses = Array.isArray(result) ? result : [result];
    for (const entry of addresses) {
      if (isBlockedIP(entry.address)) {
        logger.error('Rejected blocked IP', { hostname: targetURL.hostname, ip: entry.address, url: targetURL.toString() }, { function: 'validateTargetURL' });
        return errorResponse('invalid_request', `The resolved address for '${targetURL.hostname}' is not allowed`, 400, context);
      }
    }
  } catch (dnsError) {
    logger.error('DNS lookup failed', dnsError, { function: 'validateTargetURL' });
    return errorResponse('fetch_failed', `DNS lookup failed for '${targetURL.hostname}'`, 502, context);
  }

  return null;
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

function isRunRequestBody(value: unknown): value is RunRequestBody {
  if (value == null || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return (
    (object.type === 'test' || object.type === 'run')
    && typeof object.url === 'string'
    && typeof object.code === 'string'
  );
}

async function handleRun(body: string | undefined, context: ResponseContext): Promise<LambdaResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(body ?? '');
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!isRunRequestBody(raw)) {
    const object = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (!object.type || (object.type !== 'test' && object.type !== 'run')) {
      return errorResponse('invalid_request', "Field 'type' must be 'test' or 'run'", 400, context);
    }
    if (!object.url || typeof object.url !== 'string') {
      return errorResponse('invalid_request', "Field 'url' is required and must be a string", 400, context);
    }
    return errorResponse('invalid_request', "Field 'code' is required and must be a string", 400, context);
  }

  const parsed = raw;

  if (parsed.code.length > MAX_CODE_LENGTH) {
    return errorResponse('invalid_request', `Field 'code' exceeds maximum length of ${MAX_CODE_LENGTH} characters`, 400, context);
  }

  let targetURL: URL;
  try {
    targetURL = new URL(parsed.url);
  } catch {
    return errorResponse('invalid_request', "Field 'url' must be a valid URL", 400, context);
  }

  const ssrfError = await validateTargetURL(targetURL, context);
  if (ssrfError) {
    return ssrfError;
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
    const sandbox = createContext({
      Array,
      Boolean,
      Date,
      Error,
      JSON,
      Map,
      Math,
      Number,
      Object,
      Promise,
      RegExp,
      Set,
      String,
      TypeError,
      RangeError,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      undefined,
      NaN,
      Infinity,
    });
    const script = new Script(`(${parsed.code})`);
    const userFunction = script.runInContext(sandbox, { timeout: CODE_EXECUTION_TIMEOUT_MILLISECONDS });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const asyncTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Async execution timed out')), CODE_EXECUTION_TIMEOUT_MILLISECONDS);
      timer.unref();
    });
    try {
      result = await Promise.race([userFunction(responseText), asyncTimeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (executionError) {
    logger.error('Code execution failed', executionError, { function: 'handleRun' });
    if (
      executionError != null
      && typeof executionError === 'object'
      && 'code' in executionError
      && executionError.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    ) {
      return errorResponse('execution_timeout', `Code execution timed out after ${CODE_EXECUTION_TIMEOUT_MILLISECONDS}ms`, 422, context);
    }
    const message = executionError instanceof Error
      ? executionError.message
      : 'Unknown execution error';
    if (message === 'Async execution timed out') {
      return errorResponse('execution_timeout', `Code execution timed out after ${CODE_EXECUTION_TIMEOUT_MILLISECONDS}ms`, 422, context);
    }
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
