import { trace, SpanStatusCode, type Span } from '@opentelemetry/api';

/**
 * Get the current active span from the OpenTelemetry context
 */
export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

/**
 * Add an event to the current active span
 *
 * @param name - Event name
 * @param attributes - Optional attributes to attach to the event
 */
export function addSpanEvent(
  name: string,
  attributes?: Record<string, string | number | boolean>
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Set an attribute on the current active span
 *
 * @param key - Attribute key
 * @param value - Attribute value
 */
export function setSpanAttribute(
  key: string,
  value: string | number | boolean
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(key, value);
  }
}

/**
 * Set multiple attributes on the current active span
 *
 * @param attributes - Key-value pairs of attributes
 */
export function setSpanAttributes(
  attributes: Record<string, string | number | boolean>
): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Mark the current active span as error
 *
 * @param error - Error object or message
 */
export function setSpanError(error: Error | string): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: typeof error === 'string' ? error : error.message,
    });
    if (error instanceof Error) {
      span.recordException(error);
    }
  }
}

/**
 * Create a new span and execute a function within it
 *
 * @param name - Span name
 * @param fn - Function to execute within the span
 * @returns Result of the function
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer('axiom-logger');
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
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

export { SpanStatusCode };
export type { Span };
