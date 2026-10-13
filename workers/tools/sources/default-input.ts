/**
 * Builds the input of a crawler that gets no input from a previous stage: every field of
 * the input schema that has a default (e.g. { url: { type: 'string', default: 'https://...' } }).
 * Shared by the scheduler (first stage) and the crawler manager (direct run without input).
 *
 * @throws when the input schema is not an object
 */
export function resolveDefaultInput(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema === null || inputSchema === undefined || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`Invalid input_schema: expected object, got ${typeof inputSchema}`);
  }
  const defaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value !== null && value !== undefined && typeof value === 'object' && 'default' in value) {
      defaults[key] = (value as Record<string, unknown>).default;
    }
  }
  return defaults;
}
