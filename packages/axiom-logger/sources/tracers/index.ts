export {
  traceDatabaseOperation,
  createDatabaseSpan,
} from './database.ts';

// Re-export types needed for tracing
export type { TraceDatabaseOperationOptions, DatabaseOperation } from '../types/index.ts';

// Re-export OpenTelemetry API for convenience
export { SpanStatusCode } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';
