import { describe, it, expect } from 'vitest';
import { resolveDefaultInput } from '../sources/index.ts';

// Moved from scheduler-manager-worker; the cases are the ones its stage runner tests had.
describe('resolveDefaultInput', () => {
  it('extracts default values from descriptor format', () => {
    const schema = {
      url: { type: 'string', default: 'https://example.com' },
      count: { type: 'number', default: 10 },
    };
    expect(resolveDefaultInput(schema)).toEqual({ url: 'https://example.com', count: 10 });
  });

  it('skips fields without default', () => {
    const result = resolveDefaultInput({
      url: { type: 'string', default: 'https://example.com' },
      query: { type: 'string' },
    });
    expect(result).toEqual({ url: 'https://example.com' });
    expect(result).not.toHaveProperty('query');
  });

  it('returns empty object for schema with no defaults', () => {
    expect(resolveDefaultInput({ url: { type: 'string' }, query: { type: 'string' } })).toEqual({});
  });

  it('handles empty schema', () => {
    expect(resolveDefaultInput({})).toEqual({});
  });

  it('ignores non-object field values', () => {
    expect(resolveDefaultInput({ url: 'not-an-object', count: 42, flag: null })).toEqual({});
  });

  it('handles default values of null and false', () => {
    expect(resolveDefaultInput({ optional: { type: 'string', default: null } })).toEqual({ optional: null });
    expect(resolveDefaultInput({ enabled: { type: 'boolean', default: false } })).toEqual({ enabled: false });
  });

  it.each([
    [null, 'object'],
    [undefined, 'undefined'],
    ['schema', 'string'],
    [42, 'number'],
    [[], 'object'],
  ])('throws for a schema that is not an object: %j', (schema, typeName) => {
    expect(() => resolveDefaultInput(schema)).toThrow(`Invalid input_schema: expected object, got ${typeName}`);
  });
});
