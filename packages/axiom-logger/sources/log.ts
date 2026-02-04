import { trace } from '@opentelemetry/api';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Log a message to the current active span as an event.
 * This will be exported to Axiom as part of the trace.
 *
 * @param level - Log level (debug, info, warn, error)
 * @param message - Log message
 * @param attributes - Optional additional attributes
 */
export function log(
  level: LogLevel,
  message: string,
  attributes?: Record<string, string | number | boolean>
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(message, {
      ...attributes,
      'log.level': level,
    });
  }
}

/**
 * Log a debug message
 */
export function logDebug(
  message: string,
  attributes?: Record<string, string | number | boolean>
): void {
  log('debug', message, attributes);
}

/**
 * Log an info message
 */
export function logInfo(
  message: string,
  attributes?: Record<string, string | number | boolean>
): void {
  log('info', message, attributes);
}

/**
 * Log a warning message
 */
export function logWarn(
  message: string,
  attributes?: Record<string, string | number | boolean>
): void {
  log('warn', message, attributes);
}

/**
 * Log an error message
 */
export function logError(
  message: string,
  error?: Error,
  attributes?: Record<string, string | number | boolean>
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(message, {
      ...attributes,
      ...(error && {
        'error.type': error.name,
        'error.message': error.message,
        ...(error.stack !== undefined && { 'error.stack': error.stack }),
      }),
      'log.level': 'error',
    });
    if (error) {
      span.recordException(error);
    }
  }
}
