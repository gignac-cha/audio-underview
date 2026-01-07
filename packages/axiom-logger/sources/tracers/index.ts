export {
  traceDatabaseOperation,
  createDatabaseSpan,
} from './database.ts';

// Span utilities
export {
  getActiveSpan,
  addSpanEvent,
  setSpanAttribute,
  setSpanAttributes,
  setSpanError,
  withSpan,
} from './span.ts';

// Re-export types needed for tracing
export type { TraceDatabaseOperationOptions, DatabaseOperation } from '../types/index.ts';

// Re-export OpenTelemetry API for convenience
export { SpanStatusCode } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';
