import { runCodeRequestBodySchema } from '@audio-underview/schemas';
import { verifyBearerToken } from './authentication.ts';
import {
  emptyResponse,
  errorResponse,
  jsonResponse,
  parseAllowedOrigins,
  type LambdaEvent,
  type LambdaResponse,
  type ResponseContext,
} from './lambda.ts';
import {
  TargetResolutionError,
  validateTargetURL,
  type LookupImplementation,
} from './network-guards.ts';
import { executeInSandbox, SandboxTimeoutError } from './sandbox.ts';

/** 대상 페이지 fetch timeout (host 측 — 스펙 §5.1) */
const FETCH_TIMEOUT_MILLISECONDS = 10_000;
/** 응답 크기 상한 — worker 구현의 10MB 제한을 초집합으로 흡수 (스펙 §5.4) */
const MAXIMUM_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface HandlerDependencies {
  fetchImplementation?: typeof fetch;
  lookupImplementation?: LookupImplementation;
  environment?: Record<string, string | undefined>;
}

const readHeader = (event: LambdaEvent, name: string): string | undefined =>
  event.headers?.[name] ?? event.headers?.[name.toLowerCase()];

const decodeBody = (event: LambdaEvent): string => {
  const body = event.body ?? '';
  return event.isBase64Encoded === true ? Buffer.from(body, 'base64').toString('utf-8') : body;
};

const fetchTargetBody = async (
  url: URL,
  fetchImplementation: typeof fetch,
  context: ResponseContext,
): Promise<{ success: true; text: string } | { success: false; response: LambdaResponse }> => {
  let response: Response;
  try {
    response = await fetchImplementation(url.toString(), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MILLISECONDS),
      redirect: 'follow',
    });
  } catch (error) {
    const isTimeout =
      typeof error === 'object' && error !== null && (error as Error).name === 'TimeoutError';
    return {
      success: false,
      response: isTimeout
        ? errorResponse('fetch_timeout', 'Fetching the target URL timed out', 504, context)
        : errorResponse('fetch_failed', 'Failed to fetch the target URL', 502, context),
    };
  }

  const contentLength = Number(response.headers.get('Content-Length') ?? '0');
  if (contentLength > MAXIMUM_RESPONSE_BYTES) {
    return {
      success: false,
      response: errorResponse('response_too_large', 'Target response is too large', 413, context),
    };
  }

  // HTTP status와 무관하게 body 텍스트를 사용자 코드에 전달한다 (레거시 계약 — 스펙 §5.1)
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf-8') > MAXIMUM_RESPONSE_BYTES) {
    return {
      success: false,
      response: errorResponse('response_too_large', 'Target response is too large', 413, context),
    };
  }
  return { success: true, text };
};

export const createHandler = (dependencies: HandlerDependencies = {}) => {
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const environment = dependencies.environment ?? process.env;

  return async (event: LambdaEvent): Promise<LambdaResponse> => {
    const context: ResponseContext = {
      origin: readHeader(event, 'Origin') ?? '',
      allowedOrigins: parseAllowedOrigins(environment.ALLOWED_ORIGINS),
    };

    try {
      const { method, path } = event.requestContext.http;

      if (method === 'OPTIONS') {
        return emptyResponse(204, context);
      }
      if (path !== '/run') {
        return errorResponse('not_found', 'Endpoint not found', 404, context);
      }
      if (method !== 'POST') {
        return errorResponse('method_not_allowed', 'Method not allowed', 405, context, {
          Allow: 'POST',
        });
      }

      // Bearer JWT 필수 (레거시 무인증 개선 — 스펙 §10.5)
      const jwtSecret = environment.JWT_SECRET;
      if (jwtSecret === undefined || jwtSecret.length === 0) {
        return errorResponse('server_error', 'Server configuration error', 500, context);
      }
      const authenticated = verifyBearerToken(readHeader(event, 'Authorization'), jwtSecret);
      if (authenticated === undefined) {
        return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(decodeBody(event));
      } catch {
        return errorResponse(
          'invalid_request',
          'Request body must be valid JSON',
          400,
          context,
        );
      }

      // 'data' 키 존재 검사 — 값이 null이어도 키만 있으면 통과 (레거시 계약)
      if (
        typeof parsedBody === 'object' &&
        parsedBody !== null &&
        (parsedBody as Record<string, unknown>).type === 'data' &&
        !('data' in parsedBody)
      ) {
        return errorResponse(
          'invalid_request',
          "Field 'data' is required for data type",
          400,
          context,
        );
      }

      const parsed = runCodeRequestBodySchema.safeParse(parsedBody);
      if (!parsed.success) {
        return errorResponse(
          'invalid_request',
          parsed.error.issues[0]?.message ?? 'Invalid request body',
          400,
          context,
        );
      }
      const request = parsed.data;

      let argument: unknown;
      if (request.type === 'web') {
        const url = new URL(request.url);
        try {
          await validateTargetURL(url, dependencies.lookupImplementation);
        } catch (error) {
          if (error instanceof TargetResolutionError) {
            return errorResponse('fetch_failed', error.message, 502, context);
          }
          return errorResponse(
            'invalid_request',
            error instanceof Error ? error.message : 'Target URL is not allowed',
            400,
            context,
          );
        }
        const fetched = await fetchTargetBody(url, fetchImplementation, context);
        if (!fetched.success) {
          return fetched.response;
        }
        argument = fetched.text;
      } else {
        argument = request.data;
      }

      let result: unknown;
      try {
        result = await executeInSandbox(request.code, argument);
      } catch (error) {
        if (error instanceof SandboxTimeoutError) {
          return errorResponse('execution_timeout', error.message, 422, context);
        }
        // 원본 에러 메시지 노출 — 에디터 디버깅 편의 (레거시 function 동작 유지)
        return errorResponse(
          'execution_failed',
          error instanceof Error ? error.message : 'Code execution failed',
          422,
          context,
        );
      }

      return jsonResponse({ type: request.type, mode: request.mode, result }, 200, context);
    } catch {
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  };
};

export const handler = createHandler();
