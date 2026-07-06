import { createWorkerLogger, type Logger } from '@audio-underview/logger';
import {
  createCORSHeaders,
  parseAllowedOrigins,
  type CORSOptions,
  type ResponseContext,
} from './cors.ts';
import { EnvironmentConfigurationError } from './environments.ts';
import { UUID_PATTERN, verifyJWT, type JWTPayload } from './jwt.ts';
import {
  errorResponse,
  helpResponse,
  methodNotAllowedResponse,
  type HelpEndpoint,
} from './responses.ts';

export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RequestContext<Environment> {
  request: Request;
  url: URL;
  environment: Environment;
  executionContext: ExecutionContext;
  parameters: Record<string, string>;
  responseContext: ResponseContext;
  logger: Logger;
  /** `requiresAuthentication: true` 라우트에서만 채워진다. */
  userUUID?: string;
  tokenPayload?: JWTPayload;
}

export interface RouteDefinition<Environment> {
  method: HTTPMethod;
  /**
   * 경로 패턴. `:name` 세그먼트는 파라미터 캡처 — 기본 검증은 UUID.
   * (UUID가 아닌 파라미터는 `parameterPatterns`로 재정의: 예 `{ provider: /^[a-z]+$/ }`)
   * 리터럴 세그먼트가 파라미터보다 우선하도록 라우트를 등록 순서대로 매칭한다
   * (`/stages/reorder`를 `/stages/:stageID`보다 먼저 등록).
   */
  pattern: string;
  requiresAuthentication?: boolean;
  parameterPatterns?: Record<string, RegExp>;
  handler: (context: RequestContext<Environment>) => Promise<Response> | Response;
}

export interface AuthenticationOptions {
  secret: string;
  issuer?: string;
  audience?: string;
}

export interface CreateWorkerRouterOptions<Environment> {
  serviceName: string;
  help: HelpEndpoint[];
  cors?: CORSOptions;
  resolveAllowedOrigins: (environment: Environment) => string | undefined;
  /** 인증 라우트가 있을 때 필수. secret 미설정이면 500 "Server configuration error". */
  resolveAuthentication?: (environment: Environment) => AuthenticationOptions | undefined;
  createLogger?: (environment: Environment) => Logger;
  routes: RouteDefinition<Environment>[];
}

interface PatternMatch {
  parameters: Record<string, string>;
  /** 구조는 맞지만 파라미터 검증(UUID 등) 실패 */
  invalidParameters: boolean;
}

const matchPattern = (
  pattern: string,
  pathname: string,
  parameterPatterns: Record<string, RegExp> | undefined,
): PatternMatch | undefined => {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = pathname.split('/').filter((segment) => segment.length > 0);

  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }

  const parameters: Record<string, string> = {};
  let invalidParameters = false;

  for (const [index, patternSegment] of patternSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) {
      return undefined;
    }

    if (patternSegment.startsWith(':')) {
      const name = patternSegment.slice(1);
      const validation = parameterPatterns?.[name] ?? UUID_PATTERN;
      if (!validation.test(pathSegment)) {
        invalidParameters = true;
      }
      parameters[name] = decodeURIComponent(pathSegment);
    } else if (patternSegment !== pathSegment) {
      return undefined;
    }
  }

  return { parameters, invalidParameters };
};

export interface WorkerRouter<Environment> {
  fetch(request: Request, environment: Environment, executionContext: ExecutionContext): Promise<Response>;
}

export const createWorkerRouter = <Environment>(
  options: CreateWorkerRouterOptions<Environment>,
): WorkerRouter<Environment> => {
  const fetchHandler = async (
    request: Request,
    environment: Environment,
    executionContext: ExecutionContext,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';
    const logger =
      options.createLogger?.(environment) ??
      createWorkerLogger({ defaultContext: { module: options.serviceName } });
    const responseContext: ResponseContext = {
      origin,
      allowedOrigins: parseAllowedOrigins(options.resolveAllowedOrigins(environment)),
      cors: options.cors,
    };

    try {
      // Preflight — 204, body 없음 (스펙 §2.2)
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: createCORSHeaders(responseContext) });
      }

      // HEAD → 200, Content-Type만 (스펙 §2.2)
      if (request.method === 'HEAD') {
        const headers = createCORSHeaders(responseContext);
        headers.set('Content-Type', 'application/json');
        return new Response(null, { status: 200, headers });
      }

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
        return helpResponse(options.serviceName, options.help, responseContext);
      }

      const allowedMethodsForPath = new Set<string>();
      let invalidParametersMatched = false;

      for (const route of options.routes) {
        const match = matchPattern(route.pattern, url.pathname, route.parameterPatterns);
        if (match === undefined) {
          continue;
        }
        if (match.invalidParameters) {
          invalidParametersMatched = true;
          continue;
        }

        allowedMethodsForPath.add(route.method);
        if (route.method !== request.method) {
          continue;
        }

        const context: RequestContext<Environment> = {
          request,
          url,
          environment,
          executionContext,
          parameters: match.parameters,
          responseContext,
          logger,
        };

        if (route.requiresAuthentication === true) {
          const authentication = options.resolveAuthentication?.(environment);
          if (authentication === undefined || authentication.secret.length === 0) {
            logger.error('JWT secret is not configured', undefined, { function: 'router' });
            return errorResponse(
              'server_error',
              'Server configuration error',
              500,
              responseContext,
            );
          }

          const authorizationHeader = request.headers.get('Authorization') ?? '';
          const token = authorizationHeader.startsWith('Bearer ')
            ? authorizationHeader.slice('Bearer '.length)
            : '';
          const payload = token.length > 0 ? await verifyJWT(token, authentication.secret, authentication) : null;

          // JWT sub는 사용자 UUID — 형식 불일치도 401 (레거시 worker 간 불일치 통일, 스펙 §8.8)
          if (payload === null || !UUID_PATTERN.test(payload.sub)) {
            return errorResponse(
              'unauthorized',
              'Valid authentication is required',
              401,
              responseContext,
            );
          }

          context.userUUID = payload.sub;
          context.tokenPayload = payload;
        }

        return await route.handler(context);
      }

      if (allowedMethodsForPath.size > 0) {
        const allow = [...allowedMethodsForPath, 'OPTIONS'].join(', ');
        return methodNotAllowedResponse(allow, responseContext);
      }

      if (invalidParametersMatched) {
        return errorResponse('not_found', 'Invalid resource path', 404, responseContext);
      }

      return errorResponse('not_found', 'Endpoint not found', 404, responseContext);
    } catch (error) {
      if (error instanceof EnvironmentConfigurationError) {
        logger.error('Environment configuration error', error, { function: 'router' });
        return errorResponse('server_error', 'Server configuration error', 500, responseContext);
      }
      logger.error('Unhandled error', error, { function: 'router' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, responseContext);
    } finally {
      executionContext.waitUntil(logger.flush());
    }
  };

  return { fetch: fetchHandler };
};
