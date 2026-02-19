import { Logger } from './logger.ts';
import type { LoggerOptions, LogLevel } from './types.ts';

declare const process: { env?: Record<string, string | undefined> } | undefined;
declare const window: unknown;
declare const document: unknown;

/**
 * Create a logger configured for browser/client-side usage
 * Uses pretty formatting for dev tools
 */
export function createBrowserLogger(options: LoggerOptions = {}): Logger {
  return new Logger({
    minimumLevel: 'debug',
    includeTimestamp: true,
    includeLevel: true,
    formatAsJSON: false,
    enabled: true,
    ...options,
  });
}

/**
 * Create a logger configured for Cloudflare Workers
 * Uses JSON formatting for observability logs
 */
export function createWorkerLogger(options: LoggerOptions = {}): Logger {
  return new Logger({
    minimumLevel: 'debug',
    includeTimestamp: true,
    includeLevel: true,
    formatAsJSON: true,
    enabled: true,
    ...options,
  });
}

/**
 * Create a logger configured for Node.js server-side usage
 * Uses JSON formatting for structured logging
 */
export function createServerLogger(options: LoggerOptions = {}): Logger {
  return new Logger({
    minimumLevel: 'info',
    includeTimestamp: true,
    includeLevel: true,
    formatAsJSON: true,
    enabled: true,
    ...options,
  });
}

/**
 * Determine the minimum log level based on environment
 */
export function getLogLevelFromEnvironment(defaultLevel: LogLevel = 'info'): LogLevel {
  // Check for LOG_LEVEL environment variable
  const envLevel = (typeof process !== 'undefined' && process.env?.LOG_LEVEL) ?? undefined;

  if (envLevel && isValidLogLevel(envLevel)) {
    return envLevel;
  }

  // Check for NODE_ENV
  const nodeEnv = (typeof process !== 'undefined' && process.env?.NODE_ENV) ?? undefined;

  if (nodeEnv === 'development') {
    return 'debug';
  }

  if (nodeEnv === 'production') {
    return 'info';
  }

  return defaultLevel;
}

/**
 * Check if a string is a valid log level
 */
function isValidLogLevel(level: string): level is LogLevel {
  return ['debug', 'info', 'warn', 'error'].includes(level);
}

/**
 * Create a logger that automatically detects the environment
 */
export function createAutoLogger(options: LoggerOptions = {}): Logger {
  // Detect browser environment
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

  // Detect Cloudflare Workers environment
  const isWorker = typeof globalThis !== 'undefined' &&
    'caches' in globalThis &&
    typeof (globalThis as { caches?: { default?: unknown } }).caches?.default !== 'undefined';

  if (isBrowser) {
    return createBrowserLogger(options);
  }

  if (isWorker) {
    return createWorkerLogger(options);
  }

  return createServerLogger(options);
}
