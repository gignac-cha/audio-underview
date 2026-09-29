import {
  type LogLevel,
  type LogContext,
  type LoggerOptions,
  type LogEntry,
  type HTTPRequestContext,
  type HTTPResponseContext,
  type ErrorContext,
  LOG_LEVEL_VALUES,
} from './types.ts';
import { redactSecrets } from './secret-redaction.ts';

/**
 * Values nested this deep or deeper are replaced with '[Truncated]' when scrubbing
 */
const SCRUB_MAXIMUM_DEPTH = 8;

/**
 * Recursively copy a value, redacting credentials from every string in it.
 * ancestorObjects holds only the objects on the current recursion path, so a shared
 * reference is expanded wherever it appears and only a real cycle becomes '[Circular]'
 */
function scrubValue(value: unknown, depth: number, ancestorObjects: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= SCRUB_MAXIMUM_DEPTH) {
    return '[Truncated]';
  }

  if (ancestorObjects.has(value)) {
    return '[Circular]';
  }

  if (value instanceof Date) {
    return value;
  }

  ancestorObjects.add(value);
  try {
    if (value instanceof Error) {
      const scrubbedError: Record<string, unknown> = {
        name: value.name,
        message: redactSecrets(value.message),
        stack: typeof value.stack === 'string' ? redactSecrets(value.stack) : undefined,
        cause: value.cause !== undefined ? scrubValue(value.cause, depth + 1, ancestorObjects) : undefined,
      };
      // Extra properties such as code or status are kept, but never replace the four fields above
      for (const [key, child] of Object.entries(value)) {
        if (!Object.hasOwn(scrubbedError, key)) {
          scrubbedError[key] = scrubValue(child, depth + 1, ancestorObjects);
        }
      }
      return scrubbedError;
    }

    // Objects such as URL are scrubbed in the form JSON.stringify would write them
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      return scrubValue(toJSON.call(value), depth + 1, ancestorObjects);
    }

    if (Array.isArray(value)) {
      return value.map((element) => scrubValue(element, depth + 1, ancestorObjects));
    }

    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      scrubbed[key] = scrubValue(child, depth + 1, ancestorObjects);
    }
    return scrubbed;
  } finally {
    ancestorObjects.delete(value);
  }
}

/**
 * Scrub a whole log entry right before it is output
 */
function scrubLogEntry(entry: LogEntry): LogEntry {
  return scrubValue(entry, 0, new WeakSet()) as LogEntry;
}

/**
 * Console-based logger with structured logging support
 */
export class Logger {
  private options: Required<LoggerOptions>;

  constructor(options: LoggerOptions = {}) {
    this.options = {
      minimumLevel: options.minimumLevel ?? 'debug',
      includeTimestamp: options.includeTimestamp ?? true,
      includeLevel: options.includeLevel ?? true,
      formatAsJSON: options.formatAsJSON ?? false,
      defaultContext: options.defaultContext ?? {},
      enabled: options.enabled ?? true,
    };
  }

  /**
   * Create a child logger with additional default context
   */
  createChild(context: LogContext): Logger {
    return new Logger({
      ...this.options,
      defaultContext: {
        ...this.options.defaultContext,
        ...context,
      },
    });
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    if (!this.options.enabled) {
      return false;
    }
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.options.minimumLevel];
  }

  /**
   * Format error for logging
   */
  private formatError(errorContext: ErrorContext): LogEntry['error'] {
    const error = errorContext.error;
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: errorContext.stack ?? error.stack,
        cause: errorContext.cause ?? error.cause,
        code: errorContext.code,
      };
    }
    return {
      name: 'UnknownError',
      message: String(error),
      stack: errorContext.stack,
      cause: errorContext.cause,
      code: errorContext.code,
    };
  }

  /**
   * Create a log entry
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: LogContext,
    data?: unknown,
    errorContext?: ErrorContext,
    request?: HTTPRequestContext,
    response?: HTTPResponseContext
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    const mergedContext = {
      ...this.options.defaultContext,
      ...context,
    };

    if (Object.keys(mergedContext).length > 0) {
      entry.context = mergedContext;
    }

    if (data !== undefined) {
      entry.data = data;
    }

    if (errorContext) {
      entry.error = this.formatError(errorContext);
    }

    if (request) {
      entry.request = request;
    }

    if (response) {
      entry.response = response;
    }

    return entry;
  }

  /**
   * Format and output a log entry
   */
  private output(level: LogLevel, entry: LogEntry): void {
    if (!this.shouldLog(level)) {
      return;
    }

    // Both JSON and pretty output use the scrubbed entry
    const scrubbedEntry = scrubLogEntry(entry);

    if (this.options.formatAsJSON) {
      this.outputJSON(level, scrubbedEntry);
    } else {
      this.outputPretty(level, scrubbedEntry);
    }
  }

  /**
   * Output log as JSON (for workers/servers)
   */
  private outputJSON(level: LogLevel, entry: LogEntry): void {
    const consoleMethod = this.getConsoleMethod(level);
    consoleMethod(JSON.stringify(entry));
  }

  /**
   * Output log in pretty format (for browser dev tools)
   */
  private outputPretty(level: LogLevel, entry: LogEntry): void {
    const consoleMethod = this.getConsoleMethod(level);
    const parts: string[] = [];

    if (this.options.includeTimestamp) {
      parts.push(`[${entry.timestamp}]`);
    }

    if (this.options.includeLevel) {
      parts.push(`[${level.toUpperCase()}]`);
    }

    if (entry.context?.module) {
      parts.push(`[${entry.context.module}]`);
    }

    if (entry.context?.function) {
      parts.push(`[${entry.context.function}]`);
    }

    parts.push(entry.message);

    const prefix = parts.join(' ');

    // Build additional info to log
    const additionalInfo: unknown[] = [];

    if (entry.context?.requestID) {
      additionalInfo.push({ requestID: entry.context.requestID });
    }

    if (entry.context?.userID) {
      additionalInfo.push({ userID: entry.context.userID });
    }

    if (entry.context?.metadata && Object.keys(entry.context.metadata).length > 0) {
      additionalInfo.push({ metadata: entry.context.metadata });
    }

    if (entry.data !== undefined) {
      additionalInfo.push({ data: entry.data });
    }

    if (entry.request) {
      additionalInfo.push({ request: entry.request });
    }

    if (entry.response) {
      additionalInfo.push({ response: entry.response });
    }

    if (entry.error) {
      additionalInfo.push({ error: entry.error });
    }

    if (additionalInfo.length > 0) {
      consoleMethod(prefix, ...additionalInfo);
    } else {
      consoleMethod(prefix);
    }
  }

  /**
   * Get the appropriate console method for a log level
   */
  private getConsoleMethod(level: LogLevel): typeof console.log {
    switch (level) {
      case 'debug':
        return console.debug.bind(console);
      case 'info':
        return console.info.bind(console);
      case 'warn':
        return console.warn.bind(console);
      case 'error':
        return console.error.bind(console);
      default:
        return console.log.bind(console);
    }
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: unknown, context?: LogContext): void {
    const entry = this.createEntry('debug', message, context, data);
    this.output('debug', entry);
  }

  /**
   * Log an info message
   */
  info(message: string, data?: unknown, context?: LogContext): void {
    const entry = this.createEntry('info', message, context, data);
    this.output('info', entry);
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: unknown, context?: LogContext): void {
    const entry = this.createEntry('warn', message, context, data);
    this.output('warn', entry);
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | unknown, context?: LogContext): void {
    const errorContext = error ? { error } : undefined;
    const entry = this.createEntry('error', message, context, undefined, errorContext);
    this.output('error', entry);
  }

  /**
   * Log an HTTP request
   */
  logRequest(
    message: string,
    request: HTTPRequestContext,
    context?: LogContext
  ): void {
    const entry = this.createEntry('info', message, context, undefined, undefined, request);
    this.output('info', entry);
  }

  /**
   * Log an HTTP response
   */
  logResponse(
    message: string,
    response: HTTPResponseContext,
    context?: LogContext
  ): void {
    const level = response.status >= 400 ? 'error' : 'info';
    const entry = this.createEntry(level, message, context, undefined, undefined, undefined, response);
    this.output(level, entry);
  }

  /**
   * Log an HTTP request-response pair
   */
  logHTTP(
    message: string,
    request: HTTPRequestContext,
    response: HTTPResponseContext,
    context?: LogContext
  ): void {
    const level = response.status >= 400 ? 'error' : 'info';
    const entry = this.createEntry(level, message, context, undefined, undefined, request, response);
    this.output(level, entry);
  }

  /**
   * Log an API error with detailed information
   */
  logAPIError(
    message: string,
    request: HTTPRequestContext,
    response: HTTPResponseContext,
    error?: Error | unknown,
    context?: LogContext
  ): void {
    const errorContext = error ? { error } : undefined;
    const entry = this.createEntry('error', message, context, undefined, errorContext, request, response);
    this.output('error', entry);
  }

  /**
   * Start timing an operation
   */
  startTimer(): () => number {
    const startTime = Date.now();
    return () => Date.now() - startTime;
  }

  /**
   * Log with timing information
   */
  logWithDuration(
    level: LogLevel,
    message: string,
    durationMilliseconds: number,
    data?: unknown,
    context?: LogContext
  ): void {
    const entry = this.createEntry(
      level,
      message,
      {
        ...context,
        metadata: {
          ...context?.metadata,
          durationMilliseconds,
        },
      },
      data
    );
    this.output(level, entry);
  }
}
