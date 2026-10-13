import type { Logger } from '@audio-underview/logger';
import type { OAuthProviderID } from '@audio-underview/sign-provider';

export interface ResponseContext {
  origin: string;
  allowedOrigins: string;
  logger: Logger;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

export type OAuthProvider = OAuthProviderID;

export interface BaseEnvironment {
  FRONTEND_URL: string;
  ALLOWED_ORIGINS: string;
  AUDIO_UNDERVIEW_OAUTH_STATE: KVNamespace;
}

export interface OAuthWorkerHandlers<Environment extends BaseEnvironment> {
  handleAuthorize: (request: Request, environment: Environment) => Promise<Response>;
  handleCallback: (request: Request, environment: Environment) => Promise<Response>;
}

export interface OAuthWorkerOptions<Environment extends BaseEnvironment> {
  provider: OAuthProvider;
  logger: Logger;
  handlers: OAuthWorkerHandlers<Environment>;
}

export interface CrawlerExecuteResult {
  type: 'web' | 'data';
  result: unknown;
}

export function validateCrawlerExecuteResult(value: unknown): CrawlerExecuteResult {
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new Error('Invalid CrawlerExecuteResult: expected object');
  }
  const record = value as Record<string, unknown>;
  if (record.type !== 'web' && record.type !== 'data') {
    throw new Error(`Invalid CrawlerExecuteResult: expected type 'web' or 'data', got '${String(record.type)}'`);
  }
  if (!('result' in record)) {
    throw new Error('Invalid CrawlerExecuteResult: missing result field');
  }
  return { type: record.type, result: record.result };
}

/** Logs of one crawler run keep entries while the sum of (message length + 64) stays within this */
export const CRAWLER_LOG_MAXIMUM_COST = 65_536;
export const CRAWLER_LOG_MAXIMUM_ENTRIES = 1_000;
/** Cost of an entry besides its message, so even empty messages cannot grow the logs without bound */
export const CRAWLER_LOG_ENTRY_OVERHEAD = 64;

export type CrawlerLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

export interface CrawlerLogEntry {
  level: CrawlerLogLevel;
  message: string;
  /** ISO 8601 */
  timestamp: string;
  /** Set by the scheduler on the entries of a fan-out stage */
  item_index?: number;
}

export interface CrawlerRunContext {
  /** The user the crawler runs for */
  userUUID: string;
  /** The scheduler run a stage belongs to; absent for a direct run */
  runID?: string;
}

export type CrawlerRunOutcome =
  | {
    status: 'completed';
    type: 'web' | 'data';
    result: unknown;
    logs: CrawlerLogEntry[];
    logs_truncated: boolean;
  }
  | {
    status: 'failed';
    type: 'web' | 'data';
    error_code: string;
    /** What a stage run records, in the same form as the stage failures before */
    error: string;
    /** The description alone */
    error_description: string;
    logs: CrawlerLogEntry[];
    logs_truncated: boolean;
  };

const CRAWLER_LOG_LEVELS: readonly string[] = ['debug', 'info', 'log', 'warn', 'error'];

function validateCrawlerLogEntry(value: unknown, index: number): CrawlerLogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid CrawlerRunOutcome: log entry ${index} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.level !== 'string' || !CRAWLER_LOG_LEVELS.includes(record.level)) {
    throw new Error(`Invalid CrawlerRunOutcome: log entry ${index} has an unknown level`);
  }
  if (typeof record.message !== 'string') {
    throw new Error(`Invalid CrawlerRunOutcome: log entry ${index} must have a string message`);
  }
  if (typeof record.timestamp !== 'string') {
    throw new Error(`Invalid CrawlerRunOutcome: log entry ${index} must have a string timestamp`);
  }
  const entry: CrawlerLogEntry = {
    level: record.level as CrawlerLogLevel,
    message: record.message,
    timestamp: record.timestamp,
  };
  if (record.item_index !== undefined) {
    if (typeof record.item_index !== 'number' || !Number.isInteger(record.item_index) || record.item_index < 0) {
      throw new Error(`Invalid CrawlerRunOutcome: log entry ${index} has an invalid item_index`);
    }
    entry.item_index = record.item_index;
  }
  return entry;
}

/**
 * Checks what the crawler manager's runCrawler returned and keeps only the contract's fields.
 *
 * @throws an Error whose message starts with 'Invalid CrawlerRunOutcome:'
 */
export function validateCrawlerRunOutcome(value: unknown): CrawlerRunOutcome {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid CrawlerRunOutcome: expected object');
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'completed' && record.status !== 'failed') {
    throw new Error(`Invalid CrawlerRunOutcome: expected status 'completed' or 'failed', got '${String(record.status)}'`);
  }
  if (record.type !== 'web' && record.type !== 'data') {
    throw new Error(`Invalid CrawlerRunOutcome: expected type 'web' or 'data', got '${String(record.type)}'`);
  }
  if (!Array.isArray(record.logs)) {
    throw new Error('Invalid CrawlerRunOutcome: logs must be an array');
  }
  if (typeof record.logs_truncated !== 'boolean') {
    throw new Error('Invalid CrawlerRunOutcome: logs_truncated must be a boolean');
  }
  const logs = record.logs.map((entry, index) => validateCrawlerLogEntry(entry, index));

  if (record.status === 'completed') {
    if (!('result' in record)) {
      throw new Error('Invalid CrawlerRunOutcome: missing result field');
    }
    return { status: 'completed', type: record.type, result: record.result, logs, logs_truncated: record.logs_truncated };
  }

  for (const field of ['error_code', 'error', 'error_description'] as const) {
    if (typeof record[field] !== 'string') {
      throw new Error(`Invalid CrawlerRunOutcome: ${field} must be a string`);
    }
  }
  return {
    status: 'failed',
    type: record.type,
    error_code: record.error_code as string,
    error: record.error as string,
    error_description: record.error_description as string,
    logs,
    logs_truncated: record.logs_truncated,
  };
}
