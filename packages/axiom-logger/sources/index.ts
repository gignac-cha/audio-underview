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

// Re-export OpenTelemetry API for convenience
export { SpanStatusCode, trace } from '@opentelemetry/api';
export type { Span } from '@opentelemetry/api';
