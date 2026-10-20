import { WorkerEntrypoint } from 'cloudflare:workers';
import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  type CrawlerExecuteResult,
  type CrawlerRunContext,
  type CrawlerRunOutcome,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
  verifyJWT,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  getSystemCrawlerByName,
  updateCrawler,
  deleteCrawler,
  createCrawlerPermission,
} from '@audio-underview/supabase-connector';
import { handleTokenExchange } from './token-exchange.ts';
import { authenticate } from './authentication.ts';
import { type Environment, createCrawlerRuntimeDependencies, createSupabaseClientFrom } from './environment.ts';
import { UUID_PATTERN } from './identifiers.ts';
import { runCrawler, runLoadedCrawler, validateRunContext } from './crawler-runtime/run-crawler.ts';
import {
  CRAWLER_NAME_MAXIMUM_LENGTH,
  checkCodeLength,
  checkEnvironmentVariableNames,
  checkURLPattern,
} from './crawler-fields.ts';
import { readPagination } from './pagination.ts';
import {
  handleRunCrawler,
  handleTestRunCrawler,
  handleTestRunWithoutCrawler,
  handleListCrawlerRuns,
  handleGetCrawlerRun,
} from './handlers/crawler-runs.ts';
import { handleDownloadFile } from './handlers/crawler-files.ts';
import {
  handleListEnvironmentVariables,
  handlePutEnvironmentVariable,
  handleDeleteEnvironmentVariable,
} from './handlers/environment-variables.ts';
import { cleanUpCrawlerFiles } from './file-cleanup.ts';

export type { CrawlerExecuteResult, CrawlerRunOutcome, Environment };

// The Workers runtime only accepts classes and types as named exports of the entry module.
// The gateway every crawler Dynamic Worker sends its requests through (its globalOutbound)
export { CrawlerOutboundGateway } from './crawler-runtime/outbound-gateway.ts';

interface CreateCrawlerRequestBody {
  name: string;
  type?: 'web' | 'data';
  url_pattern?: string;
  code: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  environment_variable_names?: string[];
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-manager-worker',
  },
});

const HELP = {
  name: 'crawler-manager-worker',
  endpoints: [
    { method: 'GET', path: '/', description: 'Show this help' },
    { method: 'POST', path: '/authentication/token', description: 'Exchange OAuth access token for a JWT' },
    { method: 'POST', path: '/crawlers', description: 'Create a crawler' },
    { method: 'GET', path: '/crawlers', description: 'List crawlers for the authenticated user' },
    { method: 'GET', path: '/crawlers/:id', description: 'Get a crawler by ID' },
    { method: 'PUT', path: '/crawlers/:id', description: 'Update a crawler by ID (full replacement)' },
    { method: 'DELETE', path: '/crawlers/:id', description: 'Delete a crawler by ID' },
    { method: 'POST', path: '/crawlers/:id/runs', description: 'Run a crawler and record the run' },
    { method: 'GET', path: '/crawlers/:id/runs', description: 'List your runs of a crawler, direct and test' },
    { method: 'GET', path: '/crawlers/:id/runs/:runID', description: 'Get a run of a crawler, direct or test' },
    { method: 'POST', path: '/crawlers/:id/test-runs', description: 'Test-run code as your crawler and record the run' },
    { method: 'POST', path: '/crawler-test-runs', description: 'Test-run code without a saved crawler and record the run' },
    { method: 'GET', path: '/crawler-test-runs', description: 'List your test runs without a saved crawler' },
    { method: 'GET', path: '/crawler-test-runs/:runID', description: 'Get a test run without a saved crawler' },
    { method: 'GET', path: '/files/:id', description: 'Download a file a crawler saved' },
    { method: 'GET', path: '/environment-variables', description: 'List the names of your environment variables' },
    { method: 'PUT', path: '/environment-variables/:name', description: 'Set an environment variable' },
    { method: 'DELETE', path: '/environment-variables/:name', description: 'Delete an environment variable' },
  ],
};


async function validateCrawlerBody(
  request: Request,
  context: ResponseContext,
): Promise<CreateCrawlerRequestBody | Response> {
  let body: CreateCrawlerRequestBody;
  try {
    body = await request.json() as CreateCrawlerRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (typeof body.name !== 'string' || !body.name.trim()) {
    return errorResponse('invalid_request', "Field 'name' is required and must be a non-empty string", 400, context);
  }

  if (typeof body.code !== 'string' || !body.code.trim()) {
    return errorResponse('invalid_request', "Field 'code' is required and must be a non-empty string", 400, context);
  }

  // Validate type (defaults to 'web')
  const crawlerType = body.type ?? 'web';
  if (crawlerType !== 'web' && crawlerType !== 'data') {
    return errorResponse('invalid_request', "Field 'type' must be 'web' or 'data'", 400, context);
  }

  // For web crawlers, url_pattern is required
  if (crawlerType === 'web') {
    if (typeof body.url_pattern !== 'string' || !body.url_pattern.trim()) {
      return errorResponse('invalid_request', "Field 'url_pattern' is required for web crawlers", 400, context);
    }
  }

  // For data crawlers, input_schema is required
  if (crawlerType === 'data') {
    if (typeof body.input_schema !== 'object' || body.input_schema === null || Array.isArray(body.input_schema)) {
      return errorResponse('invalid_request', "Field 'input_schema' is required for data crawlers and must be a JSON object", 400, context);
    }
  }

  // Validate output_schema if provided
  if (body.output_schema !== undefined) {
    if (typeof body.output_schema !== 'object' || body.output_schema === null || Array.isArray(body.output_schema)) {
      return errorResponse('invalid_request', "Field 'output_schema' must be a JSON object", 400, context);
    }
  }

  // Validate environment_variable_names if provided
  if (body.environment_variable_names !== undefined) {
    const namesMessage = checkEnvironmentVariableNames(body.environment_variable_names);
    if (namesMessage !== undefined) {
      return errorResponse('invalid_request', namesMessage, 400, context);
    }
  }

  if (body.name.length > CRAWLER_NAME_MAXIMUM_LENGTH) {
    return errorResponse('invalid_request', `Field 'name' must not exceed ${CRAWLER_NAME_MAXIMUM_LENGTH} characters`, 400, context);
  }

  if (typeof body.url_pattern === 'string') {
    const urlPatternMessage = checkURLPattern(body.url_pattern);
    if (urlPatternMessage !== undefined) {
      return errorResponse('invalid_request', urlPatternMessage, 400, context);
    }
  }

  const codeLengthMessage = checkCodeLength(body.code);
  if (codeLengthMessage !== undefined) {
    return errorResponse('invalid_request', codeLengthMessage, 400, context);
  }

  // Normalize body
  body.type = crawlerType;
  if (crawlerType === 'web') {
    body.input_schema = { body: 'string' };
  }

  return body;
}

async function handleCreateCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  const validationResult = await validateCrawlerBody(request, context);
  if (validationResult instanceof Response) {
    return validationResult;
  }
  const body = validationResult;

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const crawler = await createCrawler(supabaseClient, {
    user_uuid: userUUID,
    name: body.name,
    type: body.type,
    url_pattern: body.type === 'data' ? null : body.url_pattern,
    code: body.code,
    input_schema: body.input_schema,
    output_schema: body.output_schema,
    environment_variable_names: body.environment_variable_names ?? [],
  });

  await createCrawlerPermission(supabaseClient, {
    crawler_id: crawler.id,
    user_uuid: userUUID,
    level: 'owner',
  });

  return jsonResponse(crawler, 201, context);
}

async function handleListCrawlers(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  const pagination = readPagination(new URL(request.url), context);
  if (pagination instanceof Response) {
    return pagination;
  }

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const result = await listCrawlersByUser(supabaseClient, userUUID, pagination);
  return jsonResponse({
    data: result.data,
    total: result.total,
    offset: pagination.offset,
    limit: pagination.limit,
  }, 200, context);
}

async function handleGetCrawler(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const crawler = await getCrawler(supabaseClient, crawlerID, userUUID);
  if (!crawler) {
    return errorResponse('not_found', 'Crawler not found', 404, context);
  }

  return jsonResponse(crawler, 200, context);
}

async function handleUpdateCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  const validationResult = await validateCrawlerBody(request, context);
  if (validationResult instanceof Response) {
    return validationResult;
  }
  const body = validationResult;

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const crawler = await updateCrawler(supabaseClient, crawlerID, userUUID, {
    name: body.name,
    type: body.type,
    url_pattern: body.type === 'data' ? null : body.url_pattern,
    code: body.code,
    input_schema: body.input_schema,
    output_schema: body.output_schema,
    // Left as it is when absent, as output_schema
    environment_variable_names: body.environment_variable_names,
  });

  if (!crawler) {
    return errorResponse('not_found', 'Crawler not found or not owned by you', 404, context);
  }

  return jsonResponse(crawler, 200, context);
}

async function handleDeleteCrawler(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  const deleted = await deleteCrawler(supabaseClient, crawlerID, userUUID);
  if (!deleted) {
    return errorResponse('not_found', 'Crawler not found or not owned by you', 404, context);
  }

  return jsonResponse({ deleted: true }, 200, context);
}

const MAX_SYSTEM_CRAWLER_NAME_LENGTH = 255;

const CRAWLER_RUNS_PATTERN = /^\/crawlers\/([^/]+)\/runs$/;
const CRAWLER_RUN_PATTERN = /^\/crawlers\/([^/]+)\/runs\/([^/]+)$/;
const SAVED_CRAWLER_TEST_RUNS_PATTERN = /^\/crawlers\/([^/]+)\/test-runs$/;
const CRAWLER_TEST_RUNS_PATHNAME = '/crawler-test-runs';
const CRAWLER_TEST_RUN_PATTERN = /^\/crawler-test-runs\/([^/]+)$/;
const FILE_PATTERN = /^\/files\/([^/]+)$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^\/environment-variables\/([^/]*)$/;

function methodNotAllowed(context: ResponseContext, allow: string): Response {
  const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
  response.headers.set('Allow', allow);
  return response;
}

/**
 * The routes added with the crawler runtime: direct runs, test runs, files and environment variables.
 * Each authenticates with a user UUID. Undefined when the path is none of them.
 */
async function routeCrawlerRuntime(
  request: Request,
  url: URL,
  environment: Environment,
  context: ResponseContext,
): Promise<Response | undefined> {
  const crawlerRunsMatch = CRAWLER_RUNS_PATTERN.exec(url.pathname);
  const crawlerRunMatch = CRAWLER_RUN_PATTERN.exec(url.pathname);
  const savedCrawlerTestRunsMatch = SAVED_CRAWLER_TEST_RUNS_PATTERN.exec(url.pathname);
  const isCrawlerTestRuns = url.pathname === CRAWLER_TEST_RUNS_PATHNAME;
  const crawlerTestRunMatch = CRAWLER_TEST_RUN_PATTERN.exec(url.pathname);
  const fileMatch = FILE_PATTERN.exec(url.pathname);
  const environmentVariableMatch = ENVIRONMENT_VARIABLE_PATTERN.exec(url.pathname);
  const isEnvironmentVariables = url.pathname === '/environment-variables';
  if (
    crawlerRunsMatch === null &&
    crawlerRunMatch === null &&
    savedCrawlerTestRunsMatch === null &&
    !isCrawlerTestRuns &&
    crawlerTestRunMatch === null &&
    fileMatch === null &&
    environmentVariableMatch === null &&
    !isEnvironmentVariables
  ) {
    return undefined;
  }

  const userUUID = await authenticate(request, environment);
  if (userUUID === null) {
    return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
  }

  // GET /crawlers/:id/runs — the runs of a crawler; POST — run a crawler
  if (crawlerRunsMatch !== null) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return methodNotAllowed(context, 'GET, POST');
    }
    const crawlerID = crawlerRunsMatch[1];
    if (!UUID_PATTERN.test(crawlerID)) {
      return errorResponse('not_found', 'Crawler not found', 404, context);
    }
    if (request.method === 'GET') {
      return handleListCrawlerRuns(url, environment, context, crawlerID, userUUID);
    }
    return handleRunCrawler(request, environment, context, logger, crawlerID, userUUID);
  }

  // GET /crawlers/:id/runs/:runID — a direct run or a test run of a crawler
  if (crawlerRunMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    const [, crawlerID, runID] = crawlerRunMatch;
    if (!UUID_PATTERN.test(crawlerID) || !UUID_PATTERN.test(runID)) {
      return errorResponse('not_found', 'Crawler run not found', 404, context);
    }
    return handleGetCrawlerRun(environment, context, crawlerID, runID, userUUID);
  }

  // POST /crawlers/:id/test-runs — test-run code as a crawler of the user
  if (savedCrawlerTestRunsMatch !== null) {
    if (request.method !== 'POST') {
      return methodNotAllowed(context, 'POST');
    }
    const crawlerID = savedCrawlerTestRunsMatch[1];
    if (!UUID_PATTERN.test(crawlerID)) {
      return errorResponse('not_found', 'Crawler not found', 404, context);
    }
    return handleTestRunCrawler(request, environment, context, logger, crawlerID, userUUID);
  }

  // GET /crawler-test-runs — the test runs without a crawler; POST — test-run code without a crawler
  if (isCrawlerTestRuns) {
    if (request.method === 'GET') {
      return handleListCrawlerRuns(url, environment, context, null, userUUID);
    }
    if (request.method === 'POST') {
      return handleTestRunWithoutCrawler(request, environment, context, logger, userUUID);
    }
    return methodNotAllowed(context, 'GET, POST');
  }

  // GET /crawler-test-runs/:runID — a test run without a crawler
  if (crawlerTestRunMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    const runID = crawlerTestRunMatch[1];
    if (!UUID_PATTERN.test(runID)) {
      return errorResponse('not_found', 'Crawler run not found', 404, context);
    }
    return handleGetCrawlerRun(environment, context, null, runID, userUUID);
  }

  // GET /files/:id — download a file
  if (fileMatch !== null) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    return handleDownloadFile(environment, context, fileMatch[1], userUUID);
  }

  // GET /environment-variables — names only
  if (isEnvironmentVariables) {
    if (request.method !== 'GET') {
      return methodNotAllowed(context, 'GET');
    }
    return handleListEnvironmentVariables(environment, context, userUUID);
  }

  // PUT, DELETE /environment-variables/:name
  const name = environmentVariableMatch?.[1] ?? '';
  if (request.method === 'PUT') {
    return handlePutEnvironmentVariable(request, environment, context, name, userUUID);
  }
  if (request.method === 'DELETE') {
    return handleDeleteEnvironmentVariable(environment, context, name, userUUID);
  }
  return methodNotAllowed(context, 'PUT, DELETE');
}

function parseCrawlerID(pathname: string): string | undefined {
  const match = pathname.match(/^\/crawlers\/([0-9a-f-]+)$/i);
  const id = match?.[1];
  if (id && !UUID_PATTERN.test(id)) {
    return undefined;
  }
  return id;
}

export default class CrawlerManagerWorker extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    const environment = this.env;
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    logger.info('Request received', {
      method: request.method,
      pathname: url.pathname,
      origin,
    }, { function: 'fetch' });

    if (request.method === 'OPTIONS') {
      const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    if (!environment.JWT_SECRET) {
      logger.error('JWT_SECRET is not configured', undefined, { function: 'fetch' });
      return errorResponse('server_error', 'Server configuration error', 500, context);
    }

    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
        return jsonResponse(HELP, 200, context);
      }

      // POST /authentication/token — token exchange (unauthenticated)
      if (url.pathname === '/authentication/token') {
        if (request.method !== 'POST') {
          const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
          response.headers.set('Allow', 'POST');
          return response;
        }
        const supabaseClient = createSupabaseClient({
          supabaseURL: environment.SUPABASE_URL,
          supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
          schema: environment.SUPABASE_SCHEMA,
        });
        return await handleTokenExchange(request, supabaseClient, environment.JWT_SECRET, context);
      }

      // Matched before the /crawlers routes, whose invalid IDs answer 404 below
      const crawlerRuntimeResponse = await routeCrawlerRuntime(request, url, environment, context);
      if (crawlerRuntimeResponse !== undefined) {
        return crawlerRuntimeResponse;
      }

      // All /crawlers routes require JWT authentication
      if (url.pathname === '/crawlers' || url.pathname.startsWith('/crawlers/')) {
        const authorizationHeader = request.headers.get('Authorization');
        if (!authorizationHeader?.startsWith('Bearer ')) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }

        const token = authorizationHeader.slice('Bearer '.length);
        const payload = await verifyJWT(token, environment.JWT_SECRET);
        if (!payload) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }

        const userUUID = payload.sub;

        // POST /crawlers — create
        if (url.pathname === '/crawlers' && request.method === 'POST') {
          return await handleCreateCrawler(request, environment, context, userUUID);
        }

        // GET /crawlers — list
        if (url.pathname === '/crawlers' && request.method === 'GET') {
          return await handleListCrawlers(request, environment, context, userUUID);
        }

        // GET /crawlers/:id — get single
        const crawlerID = parseCrawlerID(url.pathname);
        if (crawlerID && request.method === 'GET') {
          return await handleGetCrawler(environment, context, crawlerID, userUUID);
        }

        // PUT /crawlers/:id — update
        if (crawlerID && request.method === 'PUT') {
          return await handleUpdateCrawler(request, environment, context, crawlerID, userUUID);
        }

        // DELETE /crawlers/:id — delete
        if (crawlerID && request.method === 'DELETE') {
          return await handleDeleteCrawler(environment, context, crawlerID, userUUID);
        }

        // If the path looks like /crawlers/<something> but parseCrawlerID returned null,
        // the resource path is invalid (not a valid UUID), so return 404
        if (!crawlerID && url.pathname.startsWith('/crawlers/')) {
          return errorResponse('not_found', 'Invalid crawler ID format', 404, context);
        }

        const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
        response.headers.set('Allow', 'GET, POST, PUT, DELETE, OPTIONS');
        return response;
      }

      return errorResponse('not_found', 'Endpoint not found', 404, context);
    } catch (error) {
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  }

  // Service Binding RPC — called by scheduler-manager-worker for every crawler stage.
  // No user ownership check: binding declaration itself is the access control. The context names
  // the user the crawler runs for; the crawler gets environment variables only when that user wrote it.
  async runCrawler(crawlerID: string, input: unknown, context: CrawlerRunContext): Promise<CrawlerRunOutcome> {
    const runContext = validateRunContext(context);
    const rpcLogger = logger.createChild({
      function: 'runCrawler',
      metadata: { crawlerID },
    });
    return runCrawler(createCrawlerRuntimeDependencies(this.env, rpcLogger), crawlerID, input, runContext);
  }

  // Service Binding RPC — resolves crawlers owned by the system user only.
  // User crawlers are never looked up by name.
  async executeCrawlerByName(name: string, input: unknown): Promise<CrawlerExecuteResult> {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SYSTEM_CRAWLER_NAME_LENGTH) {
      throw new Error('Crawler name must be a non-empty string of at most 255 characters');
    }

    const rpcLogger = logger.createChild({
      function: 'executeCrawlerByName',
      metadata: { name },
    });

    const supabaseClient = createSupabaseClientFrom(this.env);

    const crawler = await getSystemCrawlerByName(supabaseClient, name);
    if (!crawler) {
      throw new Error(`System crawler '${name}' not found`);
    }

    // Runs without a user: no environment variables, no files
    const outcome = await runLoadedCrawler(
      createCrawlerRuntimeDependencies(this.env, rpcLogger, supabaseClient),
      crawler,
      input,
      undefined,
    );
    if (outcome.status === 'failed') {
      throw new Error(outcome.error);
    }
    return { type: outcome.type, result: outcome.result };
  }

  // The cron that removes the files of expired direct runs and of deleted file rows from R2
  async scheduled(): Promise<void> {
    try {
      const result = await cleanUpCrawlerFiles({
        supabaseClient: createSupabaseClientFrom(this.env),
        bucket: this.env.CRAWLER_FILES,
        logger,
      });
      logger.info('Crawler file cleanup finished', result, { function: 'scheduled' });
    } catch (error) {
      logger.error('Crawler file cleanup failed', error, { function: 'scheduled' });
      throw error;
    }
  }
}
