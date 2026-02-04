import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { TraceDatabaseOperationOptions } from '../types/index.ts';

const TRACER_NAME = 'database';

/**
 * Traces a database operation with OpenTelemetry span.
 * Automatically records duration, success/failure, and database attributes.
 *
 * @param options - Database operation options (operation type, table name)
 * @param fn - Async function that performs the database operation
 * @returns Result of the database operation
 *
 * @example
 * ```typescript
 * const user = await traceDatabaseOperation(
 *   { serviceName: 'supabase-connector', operation: 'insert', table: 'users' },
 *   async (span) => {
 *     const { data, error } = await client.from('users').insert({}).select().single();
 *     if (error) {
 *       span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
 *       throw error;
 *     }
 *     span.setAttribute('db.affected_rows', 1);
 *     return data;
 *   }
 * );
 * ```
 */
export async function traceDatabaseOperation<T>(
  options: TraceDatabaseOperationOptions,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const spanName = `db.${options.operation} ${options.table}`;

  return tracer.startActiveSpan(spanName, async (span) => {
    // Set service name for identifying the source
    span.setAttribute('service.name', options.serviceName);

    // Set semantic convention attributes for database
    span.setAttribute('db.system', 'postgresql');
    span.setAttribute('db.name', 'supabase');
    span.setAttribute('db.operation', options.operation);
    span.setAttribute('db.sql.table', options.table);

    if (options.statement) {
      span.setAttribute('db.statement', options.statement);
    }

    const startTime = Date.now();

    try {
      const result = await fn(span);

      span.setAttribute('db.duration_ms', Date.now() - startTime);
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      span.setAttribute('db.duration_ms', Date.now() - startTime);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });

      if (error instanceof Error) {
        span.recordException(error);
      }

      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Creates a child span for database operations within an existing trace.
 * Use this when you need more control over span lifecycle.
 *
 * @param options - Database operation options
 * @returns Span that must be manually ended
 */
export function createDatabaseSpan(options: TraceDatabaseOperationOptions): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  const spanName = `db.${options.operation} ${options.table}`;

  const span = tracer.startSpan(spanName);

  // Set service name for identifying the source
  span.setAttribute('service.name', options.serviceName);

  span.setAttribute('db.system', 'postgresql');
  span.setAttribute('db.name', 'supabase');
  span.setAttribute('db.operation', options.operation);
  span.setAttribute('db.sql.table', options.table);

  if (options.statement) {
    span.setAttribute('db.statement', options.statement);
  }

  return span;
}
