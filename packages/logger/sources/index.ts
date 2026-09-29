// Logger class
export { Logger } from './logger.ts';

// Factory functions
export {
  createBrowserLogger,
  createWorkerLogger,
  createServerLogger,
  createAutoLogger,
  getLogLevelFromEnvironment,
} from './factories.ts';

// Types
export type {
  LogLevel,
  LogContext,
  LoggerOptions,
  LogEntry,
  HTTPRequestContext,
  HTTPResponseContext,
  ErrorContext,
} from './types.ts';

export { LOG_LEVEL_VALUES } from './types.ts';

// Secret redaction
export {
  PROVIDER_TEXT_MAXIMUM_LENGTH,
  redactSecrets,
  truncateText,
  redactAndTruncate,
} from './secret-redaction.ts';
