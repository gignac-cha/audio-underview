/**
 * Log levels for the logger
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Numeric values for log levels (for comparison)
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Context information for logging
 */
export interface LogContext {
  /** Name of the module or component */
  module?: string;
  /** Function or method name */
  function?: string;
  /** Request ID for tracing */
  requestID?: string;
  /** User ID if available */
  userID?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * HTTP request context for logging
 */
export interface HTTPRequestContext {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * HTTP response context for logging
 */
export interface HTTPResponseContext {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: unknown;
  durationMilliseconds?: number;
}

/**
 * Error context for detailed error logging
 */
export interface ErrorContext {
  error: Error | unknown;
  stack?: string;
  cause?: unknown;
  code?: string | number;
}

/**
 * Logger configuration options
 */
export interface LoggerOptions {
  /** Minimum log level to output */
  minimumLevel?: LogLevel;
  /** Whether to include timestamps */
  includeTimestamp?: boolean;
  /** Whether to include log level in output */
  includeLevel?: boolean;
  /** Whether to format output as JSON (for workers/server) */
  formatAsJSON?: boolean;
  /** Default context to include in all logs */
  defaultContext?: LogContext;
  /** Whether logging is enabled */
  enabled?: boolean;
}

/**
 * Structured log entry
 */
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  data?: unknown;
  error?: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
    code?: string | number;
  };
  request?: HTTPRequestContext;
  response?: HTTPResponseContext;
}
