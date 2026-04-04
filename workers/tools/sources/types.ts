import type { Logger } from '@audio-underview/logger';

export interface ResponseContext {
  origin: string;
  allowedOrigins: string;
  logger: Logger;
}

export interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

export type OAuthProvider =
  | 'apple'
  | 'discord'
  | 'facebook'
  | 'github'
  | 'google'
  | 'kakao'
  | 'microsoft'
  | 'naver'
  | 'twitch'
  | 'twitter';

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
  if (value == null || typeof value !== 'object') {
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
