import type { Logger } from '@audio-underview/logger';
import {
  type ResponseContext,
  type CrawlerRunOutcome,
  jsonResponse,
  errorResponse,
  resolveDefaultInput,
} from '@audio-underview/worker-tools';
import {
  getCrawlerByID,
  getCrawlerPermission,
  createCrawlerRun,
  getCrawlerRunForUser,
} from '@audio-underview/supabase-connector';
import { type Environment, createCrawlerRuntimeDependencies, createSupabaseClientFrom } from '../environment.ts';
import { EnvironmentVariablesUnavailableError, runLoadedCrawler } from '../crawler-runtime/run-crawler.ts';

type RunRequestBody = { hasInput: false } | { hasInput: true; input: unknown };

async function readRunRequestBody(request: Request, context: ResponseContext): Promise<RunRequestBody | Response> {
  const text = await request.text();
  if (text.trim() === '') {
    return { hasInput: false };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }
  if (!Object.hasOwn(body, 'input')) {
    return { hasInput: false };
  }
  return { hasInput: true, input: (body as Record<string, unknown>).input };
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
  const body = await readRunRequestBody(request, context);
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

  let input: unknown;
  if (body.hasInput) {
    input = body.input;
  } else {
    try {
      input = resolveDefaultInput(crawler.input_schema);
    } catch (error) {
      return errorResponse('invalid_request', error instanceof Error ? error.message : String(error), 400, context);
    }
  }

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
      function: 'handleRunCrawler',
      metadata: { crawlerID: crawler.id },
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
 * GET /crawlers/:id/runs/:runID: a direct run of this crawler that this user started.
 */
export async function handleGetCrawlerRun(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
  runID: string,
  userUUID: string,
): Promise<Response> {
  const run = await getCrawlerRunForUser(createSupabaseClientFrom(environment), runID, crawlerID, userUUID);
  if (run === undefined) {
    return errorResponse('not_found', 'Crawler run not found', 404, context);
  }
  return jsonResponse(run, 200, context);
}
