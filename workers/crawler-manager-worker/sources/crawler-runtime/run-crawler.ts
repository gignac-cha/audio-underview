import { exports } from 'cloudflare:workers';
import type { Logger } from '@audio-underview/logger';
import { type SupabaseClient, type CrawlerRow, getCrawlerByID } from '@audio-underview/supabase-connector';
import {
  type CrawlerLogEntry,
  type CrawlerLogLevel,
  type CrawlerRunContext,
  type CrawlerRunOutcome,
  limitCrawlerLogs,
} from '@audio-underview/worker-tools';
import { type CodeRunnerClient, CodeRunnerExecutionError } from '../code-runner-client.ts';
import { isUUID } from '../identifiers.ts';
import { isSafeURLPattern } from '../safe-url-pattern.ts';
import { type UserVaultClient, UserVaultError } from '../user-vault-client.ts';
import { CrawlerFileCapability, closeFileCapability } from './file-capability.ts';
import { createRedactor, type Redactor } from './redaction.ts';
import {
  CRAWLER_ERROR_MESSAGE_MAXIMUM_LENGTH,
  CRAWLER_STACK_MAXIMUM_LENGTH,
  RUNNER_MODULE_SOURCE,
  type RunnerResponse,
} from './runner-module.ts';

/**
 * Runs the code of a crawler in a Dynamic Worker:
 * 1. the environment variables of the user the crawler declares, only when the user wrote the crawler
 * 2. for a web crawler, the page body fetched by the code runner Lambda as before
 * 3. the code in a Dynamic Worker per user, code, options and environment, with the runner module
 * 4. the result, logs and errors, redacted
 * Failures of the code are a failed outcome, so its logs are kept; a missing crawler, a database
 * error, an invalid context and an unreadable vault throw.
 */

export const CRAWLER_CODE_MAXIMUM_LENGTH = 1_048_576;
export const RUNNER_TIMEOUT_MILLISECONDS = 300_000;
export const HOST_TIMEOUT_MILLISECONDS = 310_000;
export const CPU_LIMIT_MILLISECONDS = 30_000;

/** What the code runner Lambda runs for a web crawler: the page body comes back as it is */
export const WEB_PAGE_CODE = '(body) => body';

/**
 * What a run needs of a crawler. A saved crawler (CrawlerRow) is one; a test run of code without a
 * crawler has no ID.
 */
export type RunnableCrawler = Pick<
  CrawlerRow,
  'user_uuid' | 'type' | 'code' | 'input_schema' | 'url_pattern' | 'environment_variable_names'
> & { id: string | null };

export interface CrawlerWorkerOptions {
  compatibilityDate: string;
  compatibilityFlags: string[];
  limits: { cpuMs: number };
}

export const CRAWLER_WORKER_OPTIONS: CrawlerWorkerOptions = {
  compatibilityDate: '2026-10-12',
  compatibilityFlags: ['nodejs_als'],
  limits: { cpuMs: CPU_LIMIT_MILLISECONDS },
};

// WorkerLoaderWorkerCode leaves limits optional; crawler code always runs with the CPU limit
export type CrawlerWorkerCode = WorkerLoaderWorkerCode & { limits: { cpuMs: number } };

export interface CrawlerRuntimeTimeouts {
  /** The runner ends the run with the logs so far */
  runnerMilliseconds: number;
  /** The last resort of the host, without logs */
  hostMilliseconds: number;
}

export interface CrawlerRuntimeDependencies {
  supabaseClient: SupabaseClient;
  // Only get() of the LOADER binding runs crawler code
  loader: Pick<WorkerLoader, 'get'>;
  bucket: R2Bucket;
  userVaultClient: UserVaultClient;
  codeRunnerClient: CodeRunnerClient;
  logger: Logger;
  timeouts?: CrawlerRuntimeTimeouts;
}

/**
 * The vault could not give the environment variables of a user running their own crawler.
 * The message carries the vault status and error code only.
 */
export class EnvironmentVariablesUnavailableError extends Error {
  readonly status: number;

  constructor(status: number, code: string | null) {
    super(
      status === 0
        ? 'Environment variables could not be read: vault could not be reached'
        : `Environment variables could not be read: vault responded ${status}${code === null ? '' : ` ${code}`}`,
    );
    this.name = 'EnvironmentVariablesUnavailableError';
    this.status = status;
  }
}

interface CrawlerRunnerStub {
  run(
    input: unknown,
    capabilities: { environment: Record<string, string>; files: CrawlerFileCapability | undefined; timeoutMilliseconds: number },
  ): Promise<RunnerResponse>;
}

const CRAWLER_LOG_LEVELS: readonly string[] = ['debug', 'info', 'log', 'warn', 'error'];
// As Date.prototype.toISOString writes a time between the years 0 and 9999
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function hexOf(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256HexOf(text: string): Promise<string> {
  return hexOf(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * The ID of the Dynamic Worker: never shared between users, the same for the same user, code, options
 * and environment. The options are part of the hash because get() requires the same code and options
 * for an ID. The environment is part of it because the global state of an isolate lasts between its
 * runs: code can keep a value of one run at module scope, and a run given other variables, or none,
 * would not hide it. Only a digest of the environment goes in, of its [name, value] pairs sorted by name.
 */
export async function createIsolateID(
  userUUID: string | undefined,
  options: CrawlerWorkerOptions,
  runnerModuleSource: string,
  code: string,
  environment: Record<string, string>,
): Promise<string> {
  const environmentPairs = Object.entries(environment)
    .sort(([leftName], [rightName]) => (leftName < rightName ? -1 : leftName > rightName ? 1 : 0));
  const environmentDigest = await sha256HexOf(JSON.stringify(environmentPairs));
  const hashInput = JSON.stringify({
    compatibilityDate: options.compatibilityDate,
    compatibilityFlags: options.compatibilityFlags,
    limits: options.limits,
  }) + '\0' + runnerModuleSource + '\0' + code + '\0' + environmentDigest;
  return `crawler:${userUUID ?? 'none'}:${await sha256HexOf(hashInput)}`;
}

/**
 * The gateway every fetch() of crawler code leaves through. Without it the Dynamic Worker would reach
 * the whole network, so the code does not run at all.
 */
export function outboundGatewayOf(workerExports: unknown): Fetcher {
  const gateway = (workerExports as { CrawlerOutboundGateway?: Fetcher | null } | null | undefined)?.CrawlerOutboundGateway;
  if (gateway === undefined || gateway === null) {
    throw new Error('The outbound gateway for crawler code is missing, so the code does not run');
  }
  return gateway;
}

/**
 * The Dynamic Worker for the code of a crawler, with `globalOutbound` as the gateway of its fetch() calls.
 */
export function createCrawlerWorkerCode(
  code: string,
  globalOutbound: Fetcher,
  options: CrawlerWorkerOptions = CRAWLER_WORKER_OPTIONS,
): CrawlerWorkerCode {
  return {
    compatibilityDate: options.compatibilityDate,
    compatibilityFlags: [...options.compatibilityFlags],
    mainModule: 'runner.js',
    modules: {
      'runner.js': RUNNER_MODULE_SOURCE,
      // CommonJS keeps sloppy mode, as the code ran in node:vm before
      'crawler.js': { cjs: `module.exports = (\n${code}\n);` },
    },
    env: {},
    // Every fetch() of the code goes through the gateway of this worker
    globalOutbound,
    limits: { cpuMs: options.limits.cpuMs },
  };
}

/**
 * Whether an error the runtime threw is the CPU limit: a synchronous endless loop, which timed out before.
 */
export function isCPULimitError(message: string): boolean {
  const lowerCaseMessage = message.toLowerCase();
  return lowerCaseMessage.includes('cpu time limit') || lowerCaseMessage.includes('exceeded cpu');
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

// Postgres JSONB refuses NUL and unpaired surrogates
function cleanText(text: string): string {
  return text.replace(/\u0000/g, '�').toWellFormed();
}

// Cuts without splitting a surrogate pair
function cutText(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  let end = length;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function resolveURL(
  input: unknown,
  crawler: RunnableCrawler,
): string | null {
  // 1. input.url if present
  if (input !== null && input !== undefined && typeof input === 'object' && 'url' in input) {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string' && url.length > 0) {
      return url;
    }
  }

  // 2. input_schema url default
  const inputSchema = crawler.input_schema;
  if (inputSchema.url !== null && inputSchema.url !== undefined && typeof inputSchema.url === 'object' && 'default' in inputSchema.url) {
    const defaultURL = (inputSchema.url as Record<string, unknown>).default;
    if (typeof defaultURL === 'string' && defaultURL.length > 0) {
      return defaultURL;
    }
  }

  return null;
}

function warnAboutURLPattern(crawler: RunnableCrawler, url: string, logger: Logger): void {
  if (!crawler.url_pattern) {
    return;
  }
  if (!isSafeURLPattern(crawler.url_pattern)) {
    logger.warn('Skipping url_pattern validation: potential ReDoS pattern detected', {
      urlPattern: crawler.url_pattern,
      crawlerID: crawler.id,
    }, { function: 'runCrawler' });
    return;
  }
  try {
    const pattern = new RegExp(crawler.url_pattern);
    if (!pattern.test(url)) {
      logger.warn('URL does not match crawler url_pattern', {
        url,
        urlPattern: crawler.url_pattern,
        crawlerID: crawler.id,
      }, { function: 'runCrawler' });
    }
  } catch (error: unknown) {
    logger.warn('Invalid url_pattern regex', {
      urlPattern: crawler.url_pattern,
      crawlerID: crawler.id,
      error: error instanceof Error ? error.message : String(error),
    }, { function: 'runCrawler' });
  }
}

function failedOutcome(
  type: CrawlerRow['type'],
  errorCode: string,
  error: string,
  errorDescription: string,
  logs: CrawlerLogEntry[] = [],
  logsTruncated = false,
): CrawlerRunOutcome {
  return { status: 'failed', type, error_code: errorCode, error, error_description: errorDescription, logs, logs_truncated: logsTruncated };
}

function executionFailed(
  type: CrawlerRow['type'],
  message: string,
  redactor: Redactor,
  logs: CrawlerLogEntry[] = [],
  logsTruncated = false,
): CrawlerRunOutcome {
  // Redacted before it is cut, like the logs
  const description = cutText(cleanText(redactor.redactText(message)), CRAWLER_ERROR_MESSAGE_MAXIMUM_LENGTH);
  const error = new CodeRunnerExecutionError('execution_failed', description, 422);
  return failedOutcome(type, error.errorCode, error.message, description, logs, logsTruncated);
}

function executionTimedOut(
  type: CrawlerRow['type'],
  description: string,
  logs: CrawlerLogEntry[] = [],
  logsTruncated = false,
): CrawlerRunOutcome {
  const error = new CodeRunnerExecutionError('execution_timeout', description, 422);
  return failedOutcome(type, error.errorCode, error.message, description, logs, logsTruncated);
}

/**
 * A timestamp of the runner, when it is a real time in the form YYYY-MM-DDTHH:MM:SS.sssZ; the code
 * can replace Date.prototype.toISOString, so anything else becomes the time of the host.
 */
function readTimestamp(value: unknown, hostTimestamp: string): string {
  if (typeof value !== 'string' || !LOG_TIMESTAMP_PATTERN.test(value)) {
    return hostTimestamp;
  }
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value ? value : hostTimestamp;
}

/**
 * The logs as the runner returned them, keeping only well-formed entries.
 */
function readRunnerLogs(value: unknown): CrawlerLogEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const hostTimestamp = new Date().toISOString();
  const logs: CrawlerLogEntry[] = [];
  for (const entry of value) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      typeof entry.level === 'string' &&
      CRAWLER_LOG_LEVELS.includes(entry.level) &&
      typeof entry.message === 'string'
    ) {
      logs.push({
        level: entry.level as CrawlerLogLevel,
        message: cleanText(entry.message),
        timestamp: readTimestamp(entry.timestamp, hostTimestamp),
      });
    }
  }
  return logs;
}

function toOutcome(
  type: CrawlerRow['type'],
  response: RunnerResponse,
  redactor: Redactor,
  runnerTimeoutMilliseconds: number,
): CrawlerRunOutcome {
  if (response === null || typeof response !== 'object') {
    return executionFailed(type, 'The crawler runner returned an invalid response', redactor);
  }
  // The runner shares its realm with the code, which can break its limits: they are applied again,
  // after the logs are hidden, and only a failure ends with its stack outside them
  const mayEndWithStack = response.ok !== true && response.timedOut !== true;
  const limited = limitCrawlerLogs(
    redactor.redactLogs(readRunnerLogs(response.logs)),
    mayEndWithStack ? { trailingEntryMaximumLength: CRAWLER_STACK_MAXIMUM_LENGTH } : {},
  );
  const logs = limited.logs;
  const logsTruncated = response.logsTruncated === true || limited.truncated;

  if (response.ok === true) {
    let result: unknown;
    try {
      result = JSON.parse(response.resultJSON);
    } catch {
      return executionFailed(type, 'The crawler result could not be read', redactor, logs, logsTruncated);
    }
    return { status: 'completed', type, result: redactor.redactValue(result), logs, logs_truncated: logsTruncated };
  }
  if (response.timedOut === true) {
    return executionTimedOut(type, `Code execution timed out after ${runnerTimeoutMilliseconds}ms`, logs, logsTruncated);
  }
  return executionFailed(
    type,
    typeof response.errorMessage === 'string' ? response.errorMessage : 'Unknown execution error',
    redactor,
    logs,
    logsTruncated,
  );
}

async function readEnvironment(
  dependencies: CrawlerRuntimeDependencies,
  crawlerID: string | null,
  userUUID: string,
): Promise<Record<string, string>> {
  try {
    return await dependencies.userVaultClient.resolveEnvironmentVariables(userUUID);
  } catch (error) {
    const status = error instanceof UserVaultError ? error.status : 0;
    const code = error instanceof UserVaultError ? error.code : null;
    dependencies.logger.error('Environment variables could not be read', undefined, {
      function: 'runCrawler',
      metadata: { crawlerID, userUUID, vaultStatus: status },
    });
    throw new EnvironmentVariablesUnavailableError(status, code);
  }
}

/**
 * The variables among the declared names that the vault answered; a declared name without a variable
 * is left out.
 */
export function pickDeclared(variables: Record<string, string>, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    if (Object.hasOwn(variables, name)) {
      // The database does not check the name format, and assigning '__proto__' would set the prototype
      Object.defineProperty(picked, name, { value: variables[name], enumerable: true, writable: true, configurable: true });
    }
  }
  return picked;
}

function readOutboundGateway(dependencies: CrawlerRuntimeDependencies, crawlerID: string | null): Fetcher {
  try {
    return outboundGatewayOf(exports);
  } catch (error) {
    // The deployment lacks the CrawlerOutboundGateway entrypoint of this worker
    dependencies.logger.error(messageOf(error), undefined, { function: 'runCrawler', metadata: { crawlerID } });
    throw error;
  }
}

const HOST_TIMED_OUT = Symbol('host timed out');

async function runInDynamicWorker(
  dependencies: CrawlerRuntimeDependencies,
  crawler: RunnableCrawler,
  input: unknown,
  context: CrawlerRunContext | undefined,
  environment: Record<string, string>,
  redactor: Redactor,
): Promise<CrawlerRunOutcome> {
  const timeouts = dependencies.timeouts ?? {
    runnerMilliseconds: RUNNER_TIMEOUT_MILLISECONDS,
    hostMilliseconds: HOST_TIMEOUT_MILLISECONDS,
  };
  const isolateID = await createIsolateID(context?.userUUID, CRAWLER_WORKER_OPTIONS, RUNNER_MODULE_SOURCE, crawler.code, environment);
  // Without a user there is nobody the files would belong to
  const files = context === undefined
    ? undefined
    : new CrawlerFileCapability({
      userUUID: context.userUUID,
      runID: context.runID,
      crawlerID: crawler.id,
      supabaseClient: dependencies.supabaseClient,
      bucket: dependencies.bucket,
      redactor,
      logger: dependencies.logger,
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Looked up before the loader, so a missing gateway fails the run rather than throwing inside the loader callback
    const globalOutbound = readOutboundGateway(dependencies, crawler.id);
    const worker = dependencies.loader.get(isolateID, async () => createCrawlerWorkerCode(crawler.code, globalOutbound));
    const runner = worker.getEntrypoint('CrawlerRunner') as unknown as CrawlerRunnerStub;
    const call = Promise.resolve(runner.run(input, {
      environment,
      files,
      timeoutMilliseconds: timeouts.runnerMilliseconds,
    }));
    // After the host gives up nobody waits for the call
    call.catch(() => {});
    const hostTimeout = new Promise<typeof HOST_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(HOST_TIMED_OUT), timeouts.hostMilliseconds);
    });

    const response = await Promise.race([call, hostTimeout]);
    if (response === HOST_TIMED_OUT) {
      return executionTimedOut(crawler.type, `Code execution timed out after ${timeouts.runnerMilliseconds}ms`);
    }
    return toOutcome(crawler.type, response, redactor, timeouts.runnerMilliseconds);
  } catch (error) {
    // Loading the module (a syntax error included) or running it failed
    const message = messageOf(error);
    if (isCPULimitError(message)) {
      return executionTimedOut(
        crawler.type,
        `Code execution timed out: CPU time limit of ${CRAWLER_WORKER_OPTIONS.limits.cpuMs}ms exceeded`,
      );
    }
    return executionFailed(crawler.type, message, redactor);
  } finally {
    clearTimeout(timer);
    if (files !== undefined) {
      closeFileCapability(files);
    }
  }
}

function redactOutcome(outcome: CrawlerRunOutcome, redactor: Redactor): CrawlerRunOutcome {
  const logs = redactor.redactLogs(outcome.logs);
  if (outcome.status === 'completed') {
    return { ...outcome, result: redactor.redactValue(outcome.result), logs };
  }
  return {
    ...outcome,
    error: redactor.redactText(outcome.error),
    error_description: redactor.redactText(outcome.error_description),
    logs,
  };
}

/**
 * Runs a crawler that is already read, or the code of a test run.
 *
 * @param context - the user the crawler runs for and, for a scheduled stage, the scheduler run;
 * undefined for a run without a user (executeCrawlerByName)
 * @throws EnvironmentVariablesUnavailableError when the vault cannot give the variables of the author
 */
export async function runLoadedCrawler(
  dependencies: CrawlerRuntimeDependencies,
  crawler: RunnableCrawler,
  input: unknown,
  context: CrawlerRunContext | undefined,
): Promise<CrawlerRunOutcome> {
  // A system crawler belongs to the system user, so it never gets the variables of a caller
  const ownsCrawler = context !== undefined && context.userUUID === crawler.user_uuid;
  // A row of a database before migration 014 has no such column: it declares no name
  const declaredNames: readonly string[] = crawler.environment_variable_names ?? [];
  // Without a declared name the vault is not called
  const variables = ownsCrawler && declaredNames.length > 0
    ? await readEnvironment(dependencies, crawler.id, context.userUUID)
    : {};
  const environment = pickDeclared(variables, declaredNames);
  // Every value the vault returned is hidden, the ones the code was not given too; without a vault
  // call no value is known, and the run gets an isolate that was never given one
  const redactor = createRedactor(variables);

  let outcome: CrawlerRunOutcome;
  let runInput = input;
  if (crawler.type === 'web') {
    const url = resolveURL(input, crawler);
    if (url === null) {
      const message = `${crawler.id === null ? 'Crawler test run' : `Crawler ${crawler.id}`}: no URL available. Provide url in input or set a default in input_schema.`;
      return finishRun(dependencies, crawler, failedOutcome('web', 'invalid_input', message, message), redactor);
    }
    warnAboutURLPattern(crawler, url, dependencies.logger);

    try {
      const page = await dependencies.codeRunnerClient.run('web', url, undefined, WEB_PAGE_CODE);
      if (typeof page.result !== 'string') {
        const error = new CodeRunnerExecutionError('invalid_response', 'Expected the page body as a string', 502);
        return finishRun(dependencies, crawler, failedOutcome('web', error.errorCode, error.message, error.errorDescription), redactor);
      }
      runInput = page.result;
    } catch (error) {
      if (!(error instanceof CodeRunnerExecutionError)) {
        throw error;
      }
      return finishRun(dependencies, crawler, failedOutcome('web', error.errorCode, error.message, error.errorDescription), redactor);
    }
  }

  if (crawler.code.length > CRAWLER_CODE_MAXIMUM_LENGTH) {
    outcome = executionFailed(crawler.type, `Crawler code exceeds the maximum length of ${CRAWLER_CODE_MAXIMUM_LENGTH} characters`, redactor);
  } else {
    outcome = await runInDynamicWorker(dependencies, crawler, runInput, context, environment, redactor);
  }
  return finishRun(dependencies, crawler, outcome, redactor);
}

function finishRun(
  dependencies: CrawlerRuntimeDependencies,
  crawler: RunnableCrawler,
  outcome: CrawlerRunOutcome,
  redactor: Redactor,
): CrawlerRunOutcome {
  const redactedOutcome = redactOutcome(outcome, redactor);
  if (redactedOutcome.status === 'failed') {
    // Only the code: what failed may carry the values of the environment variables
    dependencies.logger.warn('Crawler run failed', {
      crawlerID: crawler.id,
      errorCode: redactedOutcome.error_code,
    }, { function: 'runCrawler' });
  }
  return redactedOutcome;
}

/**
 * Checks the context a caller passed over RPC.
 *
 * @throws when the user UUID or the run ID is not a UUID
 */
export function validateRunContext(context: unknown): CrawlerRunContext {
  if (context === null || typeof context !== 'object') {
    throw new Error('Invalid user UUID');
  }
  const { userUUID, runID } = context as Record<string, unknown>;
  if (typeof userUUID !== 'string' || !isUUID(userUUID)) {
    throw new Error('Invalid user UUID');
  }
  if (runID !== undefined && (typeof runID !== 'string' || !isUUID(runID))) {
    throw new Error('Invalid run ID');
  }
  return runID === undefined ? { userUUID } : { userUUID, runID };
}

/**
 * Reads the crawler and runs it.
 *
 * @throws when the crawler does not exist, the database fails, or the vault cannot give the
 * environment variables of the author
 */
export async function runCrawler(
  dependencies: CrawlerRuntimeDependencies,
  crawlerID: string,
  input: unknown,
  context: CrawlerRunContext | undefined,
): Promise<CrawlerRunOutcome> {
  const crawler = await getCrawlerByID(dependencies.supabaseClient, crawlerID);
  if (!crawler) {
    throw new Error(`Crawler ${crawlerID} not found`);
  }
  return runLoadedCrawler(dependencies, crawler, input, context);
}
