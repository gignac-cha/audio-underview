/**
 * Validation of values against the JSON Schema subset task groups use for their formats.
 * Only the keywords below are understood; a schema with anything else is rejected as a whole,
 * so a format the scheduler cannot read never passes by accident.
 */

export type SchemaValidationResult =
  | { valid: true }
  | { valid: false; path: string; message: string };

/**
 * The schema uses a keyword or a keyword value outside the supported subset, or nests too deep.
 */
export class UnsupportedSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSchemaError';
  }
}

type Schema = Record<string, unknown>;

const TYPE_NAMES: ReadonlySet<string> = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set(['title', 'description', 'default', 'examples']);

const NON_NEGATIVE_INTEGER_KEYWORDS: ReadonlySet<string> = new Set(['minLength', 'maxLength', 'minItems', 'maxItems']);

const FINITE_NUMBER_KEYWORDS: ReadonlySet<string> = new Set(['minimum', 'maximum']);

// The top-level schema is depth 1; each properties or items schema is one deeper.
const MAXIMUM_SCHEMA_DEPTH = 32;

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isEnumValue(value: unknown): boolean {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function propertyPath(path: string, name: string): string {
  return IDENTIFIER_PATTERN.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

/**
 * Checks the whole schema before any value is looked at.
 *
 * @param location - where the schema sits inside the top-level schema, for the error message
 * @throws UnsupportedSchemaError
 */
function assertSupportedSchema(schema: unknown, location: string, depth: number): asserts schema is Schema {
  if (depth > MAXIMUM_SCHEMA_DEPTH) {
    throw new UnsupportedSchemaError(`Schema at ${location} is nested deeper than ${MAXIMUM_SCHEMA_DEPTH} levels`);
  }
  if (!isPlainObject(schema)) {
    throw new UnsupportedSchemaError(`Schema at ${location} must be a JSON object`);
  }

  for (const [keyword, value] of Object.entries(schema)) {
    if (ANNOTATION_KEYWORDS.has(keyword)) continue;

    if (keyword === 'type') {
      const names = Array.isArray(value) ? value : [value];
      const isValid = names.length > 0
        && names.every((name) => typeof name === 'string' && TYPE_NAMES.has(name))
        && new Set(names).size === names.length;
      if (!isValid) {
        throw new UnsupportedSchemaError(`Schema keyword 'type' at ${location} has an unsupported value`);
      }
    } else if (keyword === 'enum') {
      if (!Array.isArray(value) || value.length === 0 || !value.every(isEnumValue)) {
        throw new UnsupportedSchemaError(`Schema keyword 'enum' at ${location} has an unsupported value`);
      }
    } else if (NON_NEGATIVE_INTEGER_KEYWORDS.has(keyword)) {
      if (!isNonNegativeInteger(value)) {
        throw new UnsupportedSchemaError(`Schema keyword '${keyword}' at ${location} must be a non-negative integer`);
      }
    } else if (FINITE_NUMBER_KEYWORDS.has(keyword)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new UnsupportedSchemaError(`Schema keyword '${keyword}' at ${location} must be a finite number`);
      }
    } else if (keyword === 'items') {
      assertSupportedSchema(value, `${location}.items`, depth + 1);
    } else if (keyword === 'required') {
      if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
        throw new UnsupportedSchemaError(`Schema keyword 'required' at ${location} must be an array of strings`);
      }
    } else if (keyword === 'properties') {
      if (!isPlainObject(value)) {
        throw new UnsupportedSchemaError(`Schema keyword 'properties' at ${location} must be a JSON object`);
      }
      for (const [name, propertySchema] of Object.entries(value)) {
        assertSupportedSchema(propertySchema, propertyPath(`${location}.properties`, name), depth + 1);
      }
    } else if (keyword === 'additionalProperties') {
      if (typeof value !== 'boolean') {
        throw new UnsupportedSchemaError(`Schema keyword 'additionalProperties' at ${location} must be a boolean`);
      }
    } else {
      throw new UnsupportedSchemaError(`Schema keyword '${keyword}' at ${location} is not supported`);
    }
  }
}

function matchesType(value: unknown, typeName: string): boolean {
  switch (typeName) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function describeTypes(typeNames: string[]): string {
  if (typeNames.length === 1) return typeNames[0];
  return `${typeNames.slice(0, -1).join(', ')} or ${typeNames[typeNames.length - 1]}`;
}

function failure(path: string, message: string): SchemaValidationResult {
  return { valid: false, path, message };
}

const VALID: SchemaValidationResult = { valid: true };

/**
 * Validates a value against a schema already checked by assertSupportedSchema.
 * Returns the first mismatch only, in keyword order.
 */
function validateValue(schema: Schema, value: unknown, path: string): SchemaValidationResult {
  if (Object.hasOwn(schema, 'type')) {
    const typeNames = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!typeNames.some((typeName) => matchesType(value, typeName))) {
      return failure(path, `must be of type ${describeTypes(typeNames)}`);
    }
  }

  if (Object.hasOwn(schema, 'enum')) {
    const values = schema.enum as unknown[];
    if (!values.some((allowed) => allowed === value)) {
      return failure(path, `must be one of: ${values.map((allowed) => JSON.stringify(allowed)).join(', ')}`);
    }
  }

  if (typeof value === 'string') {
    const length = [...value].length;
    if (Object.hasOwn(schema, 'minLength') && length < (schema.minLength as number)) {
      return failure(path, `must be at least ${schema.minLength} characters long`);
    }
    if (Object.hasOwn(schema, 'maxLength') && length > (schema.maxLength as number)) {
      return failure(path, `must be at most ${schema.maxLength} characters long`);
    }
  }

  // Infinity and NaN are not numbers here, as for the type number
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Object.hasOwn(schema, 'minimum') && value < (schema.minimum as number)) {
      return failure(path, `must be at least ${schema.minimum}`);
    }
    if (Object.hasOwn(schema, 'maximum') && value > (schema.maximum as number)) {
      return failure(path, `must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (Object.hasOwn(schema, 'minItems') && value.length < (schema.minItems as number)) {
      return failure(path, `must have at least ${schema.minItems} items`);
    }
    if (Object.hasOwn(schema, 'maxItems') && value.length > (schema.maxItems as number)) {
      return failure(path, `must have at most ${schema.maxItems} items`);
    }
    if (Object.hasOwn(schema, 'items')) {
      const itemSchema = schema.items as Schema;
      for (let index = 0; index < value.length; index++) {
        const result = validateValue(itemSchema, value[index], `${path}[${index}]`);
        if (!result.valid) return result;
      }
    }
  }

  if (isPlainObject(value)) {
    if (Object.hasOwn(schema, 'required')) {
      for (const name of schema.required as string[]) {
        if (!Object.hasOwn(value, name)) {
          return failure(propertyPath(path, name), 'is required');
        }
      }
    }

    const properties = Object.hasOwn(schema, 'properties') ? schema.properties as Record<string, Schema> : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, name)) continue;
      const result = validateValue(propertySchema, value[name], propertyPath(path, name));
      if (!result.valid) return result;
    }

    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) {
          return failure(propertyPath(path, name), 'is not allowed');
        }
      }
    }
  }

  return VALID;
}

/**
 * Validates a value against a task group format.
 *
 * @throws UnsupportedSchemaError when the schema is outside the supported subset, whatever the value
 */
export function validateAgainstSchema(schema: unknown, value: unknown): SchemaValidationResult {
  assertSupportedSchema(schema, '$', 1);
  return validateValue(schema, value, '$');
}
