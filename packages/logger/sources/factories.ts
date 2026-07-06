import { isLogLevel, type LogLevel } from './levels.ts';
import { Logger, type LoggerOptions } from './logger.ts';
import { createConsoleTransport } from './transports/console-transport.ts';
import type { LogContext } from './types.ts';

export interface CreateLoggerOptions {
  minimumLevel?: LogLevel;
  defaultContext?: LogContext;
  enabled?: boolean;
  additionalTransports?: LoggerOptions['transports'];
}

const create = (
  format: 'json' | 'pretty',
  options: CreateLoggerOptions = {},
): Logger =>
  new Logger({
    minimumLevel: options.minimumLevel,
    defaultContext: options.defaultContext,
    enabled: options.enabled,
    transports: [createConsoleTransport({ format }), ...(options.additionalTransports ?? [])],
  });

/** Cloudflare Worker용 — 한 줄 JSON (observability logs 수집 친화). */
export const createWorkerLogger = (options?: CreateLoggerOptions): Logger =>
  create('json', options);

/** 서버(Lambda 등)용 — 한 줄 JSON. */
export const createServerLogger = (options?: CreateLoggerOptions): Logger =>
  create('json', options);

/** 브라우저용 — 사람이 읽는 형식. */
export const createBrowserLogger = (options?: CreateLoggerOptions): Logger =>
  create('pretty', options);

/**
 * 환경변수(`LOG_LEVEL`)에서 최소 레벨을 읽는다. 무효/미설정이면 fallback.
 */
export const getLogLevelFromEnvironment = (
  value: string | undefined,
  fallback: LogLevel = 'info',
): LogLevel => (isLogLevel(value) ? value : fallback);
