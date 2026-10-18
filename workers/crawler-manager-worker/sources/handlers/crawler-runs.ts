import type { Logger } from '@audio-underview/logger';
import {
  type ResponseContext,
  type CrawlerRunOutcome,
  jsonResponse,
  errorResponse,
  resolveDefaultInput,
} from '@audio-underview/worker-tools';
import {
  type SupabaseClient,
  type CrawlerRunKind,
  getCrawler,
  getCrawlerByID,
  getCrawlerPermission,
  createCrawlerRun,
  listCrawlerRunsForUser,
  getCrawlerRunForUser,
} from '@audio-underview/supabase-connector';
import { type Environment, createCrawlerRuntimeDependencies, createSupabaseClientFrom } from '../environment.ts';
import {
  type RunnableCrawler,
  EnvironmentVariablesUnavailableError,
  runLoadedCrawler,
} from '../crawler-runtime/run-crawler.ts';
import {
  checkCodeLength,
  checkCodePresence,
  checkEnvironmentVariableNames,
  checkURLPattern,
  isJSONObject,
} from '../crawler-fields.ts';
import { readPagination } from '../pagination.ts';

type RunInput = { hasInput: false } | { hasInput: true; input: unknown };

/** The input schema of every web crawler: its code takes the page body */
function webInputSchema(): Record<string, unknown> {
  return { body: 'string' };
}

/**
 * The JSON object of a request body.
 */
function parseJSONObjectBody(text: string, context: ResponseContext): Record<string, unknown> | Response {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }
  if (!isJSONObject(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }
  return body;
}

function readInput(body: Record<string, unknown> | undefined): RunInput {
  if (body === undefined || !Object.hasOwn(body, 'input')) {
    return { hasInput: false };
  }
  return { hasInput: true, input: body.input };
}

/**
 * The input given, or the defaults of the input schema as for a scheduler stage.
 */
function resolveRunInput(runInput: RunInput, inputSchema: unknown, context: ResponseContext): { input: unknown } | Response {
  if (runInput.hasInput) {
    return { input: runInput.input };
  }
  try {
    return { input: resolveDefaultInput(inputSchema) };
  } catch (error) {
    return errorResponse('invalid_request', error instanceof Error ? error.message : String(error), 400, context);
  }
}

interface TestRunRequestBody {
  code: string;
  /** Undefined when absent; null for no pattern */
  urlPattern: string | null | undefined;
  inputSchema: Record<string, unknown> | undefined;
  environmentVariableNames: string[] | undefined;
  input: RunInput;
}

/**
 * The body of a test run, checked as the same fields of a crawler body.
 */
function readTestRunFields(body: Record<string, unknown>, context: ResponseContext): TestRunRequestBody | Response {
  const codeMessage = checkCodePresence(body.code) ?? checkCodeLength(body.code as string);
  if (codeMessage !== undefined) {
    return errorResponse('invalid_request', codeMessage, 400, context);
  }

  const urlPattern = body.url_pattern;
  if (urlPattern !== undefined && urlPattern !== null) {
    if (typeof urlPattern !== 'string') {
      return errorResponse('invalid_request', "Field 'url_pattern' must be a string", 400, context);
    }
    const urlPatternMessage = checkURLPattern(urlPattern);
    if (urlPatternMessage !== undefined) {
      return errorResponse('invalid_request', urlPatternMessage, 400, context);
    }
  }

  if (body.input_schema !== undefined && !isJSONObject(body.input_schema)) {
    return errorResponse('invalid_request', "Field 'input_schema' must be a JSON object", 400, context);
  }

  if (body.environment_variable_names !== undefined) {
    const namesMessage = checkEnvironmentVariableNames(body.environment_variable_names);
    if (namesMessage !== undefined) {
      return errorResponse('invalid_request', namesMessage, 400, context);
    }
  }

  return {
    code: body.code as string,
    urlPattern: urlPattern as string | null | undefined,
    inputSchema: body.input_schema as Record<string, unknown> | undefined,
    environmentVariableNames: body.environment_variable_names as string[] | undefined,
    input: readInput(body),
  };
}

/**
 * The status of a failed direct run: the input is the caller's, the code is the crawler's,
 * the rest happened between the crawler manager and the page.
 */
export function resolveDirectRunStatus(outcome: Extract<CrawlerRunOutcome, { status: 'failed' }>, statusCode?: number): number {
  switch (outcome.error_code) {
    case 'invalid_input':
    case 'invalid_request':
      return 400;
    case 'execution_failed':
    case 'execution_timeout':
      return 422;
    case 'fetch_timeout':
      return 504;
  }
  // The client reads error_code, which the code runner Lambda sends as error, so a Lambda
  // invalid_request (400) or fetch_timeout (504) reaches here under another code
  if (statusCode === 400) return 400;
  if (statusCode === 504) return 504;
  return 502;
}

/**
 * The status code of the code runner Lambda inside an error of the form 'CodeRunner error <status>: ...'.
 */
function codeRunnerStatusOf(error: string): number | undefined {
  const match = /^CodeRunner error (\d+): /.exec(error);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Runs the crawler for the user, records the run, and answers the result or the failure with the logs.
 * A direct run and a test run answer alike; a test run records the code it ran.
 */
async function runAndRecord(
  environment: Environment,
  context: ResponseContext,
  logger: Logger,
  supabaseClient: SupabaseClient,
  crawler: RunnableCrawler,
  input: unknown,
  userUUID: string,
  kind: CrawlerRunKind,
): Promise<Response> {
  const startedAt = new Date().toISOString();
  let outcome: CrawlerRunOutcome;
  try {
    outcome = await runLoadedCrawler(
      createCrawlerRuntimeDependencies(environment, logger, supabaseClient),
      crawler,
      input,
      { userUUID },
    );
  } catch (error) {
    if (error instanceof EnvironmentVariablesUnavailableError) {
      return errorResponse('service_unavailable', error.message, 503, context);
    }
    throw error;
  }
  const completedAt = new Date().toISOString();

  // The run answers even when it cannot be recorded
  let runID: string | null = null;
  try {
    const run = await createCrawlerRun(supabaseClient, {
      user_uuid: userUUID,
      crawler_id: crawler.id,
      kind,
      type: crawler.type,
      // The code of a direct run is the code of its crawler
      code: kind === 'test' ? crawler.code : null,
      status: outcome.status,
      result: outcome.status === 'completed' ? outcome.result : null,
      error_code: outcome.status === 'failed' ? outcome.error_code : null,
      error: outcome.status === 'failed' ? outcome.error : null,
      logs: outcome.logs,
      logs_truncated: outcome.logs_truncated,
      started_at: startedAt,
      completed_at: completedAt,
    });
    runID = run.id;
  } catch {
    logger.error('Crawler run could not be recorded', undefined, {
      function: 'runAndRecord',
      metadata: { crawlerID: crawler.id, kind },
    });
  }

  if (outcome.status === 'completed') {
    return jsonResponse({
      run_id: runID,
      status: 'completed',
      result: outcome.result,
      logs: outcome.logs,
      logs_truncated: outcome.logs_truncated,
    }, 200, context);
  }

  return jsonResponse({
    run_id: runID,
    status: 'failed',
    error: outcome.error_code,
    error_description: outcome.error_description,
    logs: outcome.logs,
    logs_truncated: outcome.logs_truncated,
  }, resolveDirectRunStatus(outcome, codeRunnerStatusOf(outcome.error)), context);
}

/**
 * POST /crawlers/:id/runs: runs a crawler the user owns or subscribes to, records the run, and answers
 * the result or the failure with the logs.
 */
export async function handleRunCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  logger: Logger,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  // No body runs on the default input
  const text = await request.text();
  const body = text.trim() === '' ? undefined : parseJSONObjectBody(text, context);
  if (body instanceof Response) {
    return body;
  }

  const supabaseClient = createSupabaseClientFrom(environment);

  // The same rule as a scheduler stage: the owner or a subscriber
  const permission = await getCrawlerPermission(supabaseClient, crawlerID, userUUID);
  if (permission === undefined) {
    return errorResponse('not_found', 'Crawler not found', 404, context);
  }
  const crawler = await getCrawlerByID(supabaseClient, crawlerID);
  if (crawler === undefined) {
    return errorResponse('not_found', 'Crawler not found', 404, context);
  }

  const resolved = resolveRunInput(readInput(body), crawler.input_schema, context);
  if (resolved instanceof Response) {
    return resolved;
  }

  return runAndRecord(environment, context, logger, supabaseClient, crawler, resolved.input, userUUID, 'direct');
}

/**
 * POST /crawlers/:id/test-runs: runs the code of the editor as a crawler of the user, over the saved
 * crawler, and records it as a test run of that crawler. The type stays the saved one.
 */
export async function handleTestRunCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  logger: Logger,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  // Checked before the crawler is read
  const body = parseJSONObjectBody(await request.text(), context);
  if (body instanceof Response) {
    return body;
  }
  const fields = readTestRunFields(body, context);
  if (fields instanceof Response) {
    return fields;
  }

  const supabaseClient = createSupabaseClientFrom(environment);

  // Only the author may run other code as the crawler
  const saved = await getCrawler(supabaseClient, crawlerID, userUUID);
  if (saved === undefined) {
    return errorResponse('not_found', 'Crawler not found', 404, context);
  }

  const isWeb = saved.type === 'web';
  const crawler: RunnableCrawler = {
    id: saved.id,
    user_uuid: saved.user_uuid,
    type: saved.type,
    code: fields.code,
    url_pattern: isWeb && fields.urlPattern !== undefined ? fields.urlPattern : saved.url_pattern,
    input_schema: isWeb ? webInputSchema() : fields.inputSchema ?? saved.input_schema,
    environment_variable_names: fields.environmentVariableNames ?? saved.environment_variable_names,
  };

  const resolved = resolveRunInput(fields.input, crawler.input_schema, context);
  if (resolved instanceof Response) {
    return resolved;
  }

  return runAndRecord(environment, context, logger, supabaseClient, crawler, resolved.input, userUUID, 'test');
}

/**
 * POST /crawler-test-runs: runs the code of the editor for a crawler that is not saved yet, as a
 * crawler of the user, and records it as a test run without a crawler.
 */
export async function handleTestRunWithoutCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  logger: Logger,
  userUUID: string,
): Promise<Response> {
  const body = parseJSONObjectBody(await request.text(), context);
  if (body instanceof Response) {
    return body;
  }
  const type = body.type;
  if (type !== 'web' && type !== 'data') {
    return errorResponse('invalid_request', "Field 'type' must be 'web' or 'data'", 400, context);
  }
  const fields = readTestRunFields(body, context);
  if (fields instanceof Response) {
    return fields;
  }

  const crawler: RunnableCrawler = {
    id: null,
    // The user writes the code, so the declared environment variables reach it
    user_uuid: userUUID,
    type,
    code: fields.code,
    // Without a pattern a URL is not warned about
    url_pattern: type === 'web' ? fields.urlPattern ?? null : null,
    input_schema: type === 'web' ? webInputSchema() : fields.inputSchema ?? {},
    environment_variable_names: fields.environmentVariableNames ?? [],
  };

  const resolved = resolveRunInput(fields.input, crawler.input_schema, context);
  if (resolved instanceof Response) {
    return resolved;
  }

  return runAndRecord(environment, context, logger, createSupabaseClientFrom(environment), crawler, resolved.input, userUUID, 'test');
}

/**
 * GET /crawlers/:id/runs and GET /crawler-test-runs: the runs this user started, of the crawler or,
 * for null, of code without a crawler, newest first, without their result, logs and code.
 * Only the user's own runs are listed, so the crawler permission is not looked at.
 */
export async function handleListCrawlerRuns(
  url: URL,
  environment: Environment,
  context: ResponseContext,
  crawlerID: string | null,
  userUUID: string,
): Promise<Response> {
  const pagination = readPagination(url, context);
  if (pagination instanceof Response) {
    return pagination;
  }

  const result = await listCrawlerRunsForUser(createSupabaseClientFrom(environment), userUUID, {
    crawlerID,
    offset: pagination.offset,
    limit: pagination.limit,
  });
  return jsonResponse({
    data: result.data,
    total: result.total,
    offset: pagination.offset,
    limit: pagination.limit,
  }, 200, context);
}

/**
 * GET /crawlers/:id/runs/:runID and GET /crawler-test-runs/:runID: a run this user started, of the
 * crawler or, for null, of code without a crawler.
 */
export async function handleGetCrawlerRun(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string | null,
  runID: string,
  userUUID: string,
): Promise<Response> {
  const run = await getCrawlerRunForUser(createSupabaseClientFrom(environment), runID, crawlerID, userUUID);
  if (run === undefined) {
    return errorResponse('not_found', 'Crawler run not found', 404, context);
  }
  return jsonResponse(run, 200, context);
}
