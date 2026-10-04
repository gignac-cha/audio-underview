import { describe, it, expect } from 'vitest';
import { UnsupportedSchemaError, validateAgainstSchema } from '../sources/schema-validation.ts';

const titleSchema = {
  type: 'object',
  properties: { title: { type: 'string' } },
  required: ['title'],
};

// A schema nested through properties to the given depth; the top-level schema is depth 1
function nestedSchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = 1; level < depth; level++) {
    schema = { type: 'object', properties: { child: schema } };
  }
  return schema;
}

describe('validateAgainstSchema', () => {
  it.each([
    ['{} lets anything through', {}, 42],
    ['an object with its required field', titleSchema, { title: 'a' }],
    ['null for a type list with null', { type: ['string', 'null'] }, null],
    ['two code points for maxLength 2', { type: 'string', maxLength: 2 }, '😀😀'],
    ['an integer in range', { type: 'integer', minimum: 1, maximum: 10 }, 10],
    ['a field that is not in properties when additionalProperties is true', { type: 'object', properties: {}, additionalProperties: true }, { extra: 1 }],
    ['an enum value', { enum: ['a', 'b', 3, true, null] }, null],
    ['annotations alone', { title: 'T', description: 'D', default: 1, examples: [1] }, 'anything'],
    ['an integer for number', { type: 'number' }, 3],
    // A number is a finite number, so minimum and maximum do not apply to Infinity or NaN
    ['Infinity with minimum and no type', { minimum: 5 }, Number.POSITIVE_INFINITY],
    ['Infinity with maximum and no type', { maximum: 10 }, Number.POSITIVE_INFINITY],
    ['-Infinity with minimum and no type', { minimum: 5 }, Number.NEGATIVE_INFINITY],
    ['-Infinity with maximum and no type', { maximum: 10 }, Number.NEGATIVE_INFINITY],
    ['NaN with minimum and no type', { minimum: 5 }, Number.NaN],
    ['NaN with maximum and no type', { maximum: 10 }, Number.NaN],
    // The inherited function is not the field's value, so it is not validated
    ['an object that only inherits a field in properties', { type: 'object', properties: { toString: { type: 'string' } } }, {}],
  ])('passes %s', (_, schema, value) => {
    expect(validateAgainstSchema(schema, value)).toEqual({ valid: true });
  });

  it.each([
    ['a missing required field', titleSchema, {}, '$.title', 'is required'],
    ['a field of the wrong type', titleSchema, { title: 1 }, '$.title', 'must be of type string'],
    ['an array for an object', titleSchema, [], '$', 'must be of type object'],
    ['null for an object', titleSchema, null, '$', 'must be of type object'],
    [
      'a field outside properties when additionalProperties is false',
      { ...titleSchema, additionalProperties: false },
      { title: 'a', extra: 1 },
      '$.extra',
      'is not allowed',
    ],
    [
      'an array item without its required field',
      { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
      [{ url: 'a' }, {}],
      '$[1].url',
      'is required',
    ],
    ['a value outside a type list of two', { type: ['string', 'null'] }, 1, '$', 'must be of type string or null'],
    ['a value outside a type list of three', { type: ['string', 'number', 'null'] }, true, '$', 'must be of type string, number or null'],
    ['a fraction for integer', { type: 'integer', minimum: 1, maximum: 10 }, 1.5, '$', 'must be of type integer'],
    ['a number below minimum', { type: 'integer', minimum: 1, maximum: 10 }, 0, '$', 'must be at least 1'],
    ['a number above maximum', { type: 'integer', minimum: 1, maximum: 10 }, 11, '$', 'must be at most 10'],
    ['NaN for number', { type: 'number' }, Number.NaN, '$', 'must be of type number'],
    ['Infinity for number', { type: 'number' }, Number.POSITIVE_INFINITY, '$', 'must be of type number'],
    ['Infinity for number with maximum', { type: 'number', maximum: 10 }, Number.POSITIVE_INFINITY, '$', 'must be of type number'],
    ['-Infinity for number with minimum', { type: 'number', minimum: 5 }, Number.NEGATIVE_INFINITY, '$', 'must be of type number'],
    ['NaN for number with minimum and maximum', { type: 'number', minimum: 5, maximum: 10 }, Number.NaN, '$', 'must be of type number'],
    ['a value outside enum', { enum: ['a', 'b', 3] }, 'c', '$', 'must be one of: "a", "b", 3'],
    ['enum before minLength', { type: 'string', enum: ['a'], minLength: 3 }, 'ab', '$', 'must be one of: "a"'],
    ['a string shorter than minLength', { type: 'string', minLength: 3 }, 'ab', '$', 'must be at least 3 characters long'],
    ['a string longer than maxLength', { type: 'string', maxLength: 80 }, 'a'.repeat(81), '$', 'must be at most 80 characters long'],
    ['an array shorter than minItems', { type: 'array', minItems: 1 }, [], '$', 'must have at least 1 items'],
    ['an array longer than maxItems', { type: 'array', maxItems: 1 }, [1, 2], '$', 'must have at most 1 items'],
    [
      'a field name that is not an identifier',
      { type: 'object', properties: { 'field name': { type: 'string' } } },
      { 'field name': 1 },
      '$["field name"]',
      'must be of type string',
    ],
    ['an inherited property for required', { type: 'object', required: ['toString'] }, {}, '$.toString', 'is required'],
    [
      'a field named like an inherited property when additionalProperties is false',
      { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false },
      { title: 'a', toString: 1 },
      '$.toString',
      'is not allowed',
    ],
    [
      'a field named constructor when additionalProperties is false',
      { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false },
      { title: 'a', constructor: 1 },
      '$.constructor',
      'is not allowed',
    ],
    [
      'a nested path through items and properties',
      { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } } } },
      { items: [{ url: 'a' }, { url: 'b' }, { url: 3 }] },
      '$.items[2].url',
      'must be of type string',
    ],
  ])('reports %s', (_, schema, value, path, message) => {
    expect(validateAgainstSchema(schema, value)).toEqual({ valid: false, path, message });
  });

  it('applies keywords only to values of their type', () => {
    const schema = { minLength: 3, minimum: 5, minItems: 2, required: ['a'], properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(validateAgainstSchema(schema, 1)).toEqual({ valid: false, path: '$', message: 'must be at least 5' });
    expect(validateAgainstSchema(schema, 'abc')).toEqual({ valid: true });
    expect(validateAgainstSchema(schema, true)).toEqual({ valid: true });
    expect(validateAgainstSchema(schema, null)).toEqual({ valid: true });
  });

  it('checks required in its listed order, properties in schema order, and extra fields in value order', () => {
    const schema = {
      type: 'object',
      properties: { b: { type: 'string' }, a: { type: 'string' } },
      required: ['z', 'y'],
      additionalProperties: false,
    };
    expect(validateAgainstSchema(schema, {})).toEqual({ valid: false, path: '$.z', message: 'is required' });
    expect(validateAgainstSchema(schema, { z: 1, y: 1, a: 1, b: 1 })).toEqual({ valid: false, path: '$.b', message: 'must be of type string' });
    expect(validateAgainstSchema(schema, { y: 1, z: 1, b: 's', a: 's' })).toEqual({ valid: false, path: '$.y', message: 'is not allowed' });
  });

  it('validates an object without a prototype like a plain object', () => {
    const schema = { ...titleSchema, additionalProperties: false };
    function objectWithoutPrototype(fields: Record<string, unknown>): Record<string, unknown> {
      return Object.assign(Object.create(null) as Record<string, unknown>, fields);
    }

    expect(validateAgainstSchema(schema, objectWithoutPrototype({ title: 'a' }))).toEqual({ valid: true });
    expect(validateAgainstSchema(schema, objectWithoutPrototype({}))).toEqual({ valid: false, path: '$.title', message: 'is required' });
    expect(validateAgainstSchema(schema, objectWithoutPrototype({ title: 1 }))).toEqual({ valid: false, path: '$.title', message: 'must be of type string' });
    expect(validateAgainstSchema(schema, objectWithoutPrototype({ title: 'a', extra: 1 }))).toEqual({ valid: false, path: '$.extra', message: 'is not allowed' });
  });

  it('checks minItems and maxItems before the items', () => {
    const schema = { type: 'array', maxItems: 1, items: { type: 'string' } };
    expect(validateAgainstSchema(schema, [1, 2])).toEqual({ valid: false, path: '$', message: 'must have at most 1 items' });
  });

  // Each value violates both keywords, so only the one checked first is reported
  it.each([
    ['type before enum', { type: 'number', enum: [1] }, 'a', '$', 'must be of type number'],
    ['minLength before maxLength', { type: 'string', minLength: 3, maxLength: 1 }, 'ab', '$', 'must be at least 3 characters long'],
    ['minimum before maximum', { type: 'number', minimum: 3, maximum: 1 }, 2, '$', 'must be at least 3'],
    ['minItems before maxItems', { type: 'array', minItems: 3, maxItems: 1 }, [1, 2], '$', 'must have at least 3 items'],
    ['minItems before the items', { type: 'array', minItems: 3, items: { type: 'string' } }, [1], '$', 'must have at least 3 items'],
  ])('reports %s for a value that violates both', (_, schema, value, path, message) => {
    expect(validateAgainstSchema(schema, value)).toEqual({ valid: false, path, message });
  });

  it('checks required before properties before additionalProperties', () => {
    const schema = {
      type: 'object',
      required: ['missing'],
      properties: { missing: {}, title: { type: 'string' } },
      additionalProperties: false,
    };
    // Violates all three
    expect(validateAgainstSchema(schema, { title: 1, extra: 1 })).toEqual({ valid: false, path: '$.missing', message: 'is required' });
    // Violates properties and additionalProperties
    expect(validateAgainstSchema(schema, { missing: 1, title: 1, extra: 1 })).toEqual({
      valid: false,
      path: '$.title',
      message: 'must be of type string',
    });
    // Violates required and additionalProperties
    expect(validateAgainstSchema(schema, { extra: 1 })).toEqual({ valid: false, path: '$.missing', message: 'is required' });
  });

  it.each([
    ['an unknown keyword', { oneOf: [] }],
    ['an unknown type name', { type: 'date' }],
    ['an empty type list', { type: [] }],
    ['a type list with a repeated name', { type: ['string', 'string'] }],
    ['an object for additionalProperties', { additionalProperties: {} }],
    ['an array for items', { items: [] }],
    ['a negative minLength', { minLength: -1 }],
    ['a fractional maxItems', { maxItems: 1.5 }],
    ['a string for minimum', { minimum: '1' }],
    ['an empty enum', { enum: [] }],
    ['an object in enum', { enum: [{}] }],
    ['a non-string in required', { required: [1] }],
    ['an array for properties', { properties: [] }],
    ['an unknown keyword inside properties', { properties: { a: { pattern: 'x' } } }],
    ['an unknown keyword inside items', { items: { format: 'uri' } }],
    ['null', null],
    ['a string', 'string'],
    ['an array', []],
    ['a $ref keyword', { $ref: '#/definitions/a' }],
    ['a $ref keyword inside properties', { type: 'object', properties: { a: { $ref: '#/definitions/a' } } }],
    ['a minimum that is not finite', { minimum: Number.POSITIVE_INFINITY }],
    ['a maximum that is NaN', { maximum: Number.NaN }],
    ['a type that is a number', { type: 3 }],
    ['an enum that is not an array', { enum: 'a' }],
    ['an object after the other values in enum', { enum: ['a', { b: 1 }] }],
    ['an array in enum', { enum: [['a']] }],
    ['a property whose schema is null', { properties: { a: null } }],
    ['a number', 1],
    ['a string for required', { required: 'a' }],
    ['a required list with a string and a number', { required: ['a', 1] }],
  ])('throws UnsupportedSchemaError for %s, whatever the value', (_, schema) => {
    expect(() => validateAgainstSchema(schema, {})).toThrow(UnsupportedSchemaError);
    expect(() => validateAgainstSchema(schema, 'x')).toThrow(UnsupportedSchemaError);
  });

  it('throws for an unsupported part the value never reaches', () => {
    // The value has no field a, but the whole schema is checked first
    expect(() => validateAgainstSchema({ type: 'object', properties: { a: { pattern: 'x' } } }, {})).toThrow(UnsupportedSchemaError);
  });

  it('accepts a schema 32 levels deep and rejects one 33 levels deep', () => {
    expect(() => validateAgainstSchema(nestedSchema(32), {})).not.toThrow();
    expect(() => validateAgainstSchema(nestedSchema(33), {})).toThrow(UnsupportedSchemaError);
  });

  it('counts items schemas toward the depth', () => {
    let schema: Record<string, unknown> = {};
    for (let level = 1; level < 33; level++) {
      schema = { type: 'array', items: schema };
    }
    expect(() => validateAgainstSchema(schema, [])).toThrow(UnsupportedSchemaError);
  });
});
