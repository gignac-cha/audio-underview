// Types
export type {
  AxiomLoggerConfiguration,
  ConfigurationResolver,
  DatabaseOperation,
  TraceDatabaseOperationOptions,
} from './types/index.ts';

// Worker instrumentation
export { instrumentWorker } from './instrument.ts';

// Database tracers
export {
  traceDatabaseOperation,
  createDatabaseSpan,
} from './tracers/index.ts';

// Span utilities
export {
  getActiveSpan,
  addSpanEvent,
  setSpanAttribute,
  setSpanAttributes,
  setSpanError,
  withSpan,
} from './tracers/span.ts';

// Log functions
export {
  log,
  logDebug,
  logInfo,
  logWarn,
  logError,
  type LogLevel,
} from './log.ts';

// Re-export OpenTelemetry API for convenience
export { SpanStatusCode, trace } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';
