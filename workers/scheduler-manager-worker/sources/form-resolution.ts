import type {
  SchedulerFormChoice,
  SchedulerFormField,
  SchedulerFormWidget,
  SchedulerStageRunForm,
} from '@audio-underview/supabase-connector';
import { CHOICE_WIDGETS, type FormDefinition, type FormFieldSchema } from './form-definition.ts';
import { isExtensionKey, propertyPath } from './schema-validation.ts';

/**
 * Resolves the form a form stage run shows from the definition of its stage and its input, and maps
 * an answer back to the values its choices stand for. Resolving is deterministic: the same definition
 * and input give the same fields and choices in the same order, so an answer can be mapped with a
 * second resolution of the input the stage run kept.
 */

export const MAXIMUM_FORM_CHOICES = 200;
export const MAXIMUM_CHOICE_LABEL_LENGTH = 300;

/** The form without its expiry, and what the choices stand for */
export interface ResolvedForm {
  schema: Record<string, unknown>;
  fields: SchedulerFormField[];
  /** The value each choice stands for, by field name; only choice fields have one */
  choiceValues: Map<string, unknown[]>;
}

export type FormResolution =
  | { resolved: true; form: ResolvedForm }
  /** A field takes its choices from the input and found none */
  | { resolved: false; fieldName: string };

export type AnswerMapping =
  | { mapped: true; output: Record<string, unknown> }
  /** The definition no longer gives the choices the form showed */
  | { mapped: false };

interface ResolvedChoices {
  choices: SchedulerFormChoice[];
  values: unknown[];
}

// The numeric limits a field of the form keeps from its schema
const FIELD_LIMIT_KEYS = ['minItems', 'maxItems', 'maxLength', 'minimum', 'maximum'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether two JSON values are equal, whatever the order of the keys of their objects
 * (the database does not keep it).
 */
function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => isDeepEqual(value, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length
      && leftKeys.every((key) => Object.hasOwn(right, key) && isDeepEqual(left[key], right[key]));
  }
  return false;
}

function fromPathSegments(path: string): string[] {
  return path === '$' ? [] : path.slice('$.'.length).split('.');
}

function itemPathSegments(path: string): string[] {
  return path === '$' ? [] : path.split('.');
}

/**
 * The value at a path: names of properties of objects, numbers of array items.
 *
 * @returns undefined when the path does not lead to a value
 */
function readPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (isPlainObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A value as the text of a choice: strings as they are, other values as JSON */
function choiceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function choiceOf(labelValue: unknown, descriptionValue: unknown): SchedulerFormChoice {
  const label = [...choiceText(labelValue)].slice(0, MAXIMUM_CHOICE_LABEL_LENGTH).join('');
  const description = choiceText(descriptionValue);
  return description === '' ? { label } : { label, description };
}

/**
 * The choices of a choice field, at most MAXIMUM_FORM_CHOICES of them.
 *
 * @returns undefined when the field takes its choices from the input and the path there does not
 * lead to an array with items
 */
function resolveChoices(field: FormFieldSchema, input: unknown): ResolvedChoices | undefined {
  const options = field['x-options'];
  if (options !== undefined) {
    const list = readPath(input, fromPathSegments(options.from));
    if (!Array.isArray(list) || list.length === 0) return undefined;

    const items = list.slice(0, MAXIMUM_FORM_CHOICES);
    const labelSegments = itemPathSegments(options.label);
    const descriptionSegments = options.description === undefined ? undefined : itemPathSegments(options.description);
    const valueSegments = options.value === undefined ? undefined : itemPathSegments(options.value);
    return {
      choices: items.map((item) => choiceOf(
        readPath(item, labelSegments),
        descriptionSegments === undefined ? undefined : readPath(item, descriptionSegments),
      )),
      // JSON has no undefined, so an item without the value stands for null
      values: items.map((item) => (valueSegments === undefined ? item : readPath(item, valueSegments) ?? null)),
    };
  }

  // The check of the definition made these a non-empty enum
  const enumValues = (field['x-widget'] === 'checkboxes' ? (field.items as Record<string, unknown>).enum : field.enum) as unknown[];
  const values = enumValues.slice(0, MAXIMUM_FORM_CHOICES);
  return { choices: values.map((value) => choiceOf(value, undefined)), values };
}

function indexOfValue(values: unknown[], value: unknown): number {
  return values.findIndex((candidate) => isDeepEqual(candidate, value));
}

/**
 * The default of a choice field as the numbers of its choices, when every value of it is a choice.
 */
function choiceDefault(field: FormFieldSchema, values: unknown[]): number | number[] | undefined {
  if (!Object.hasOwn(field, 'default')) return undefined;
  if (field['x-widget'] === 'checkboxes') {
    if (!Array.isArray(field.default)) return undefined;
    const indices = field.default.map((value) => indexOfValue(values, value));
    return indices.every((index) => index >= 0) ? indices : undefined;
  }
  const index = indexOfValue(values, field.default);
  return index >= 0 ? index : undefined;
}

function pickKeys(schema: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(schema, key)).map((key) => [key, schema[key]] as const));
}

/**
 * The schema of a choice field: the numbers 0 to n-1 of its choices instead of their values.
 */
function choiceFieldSchema(field: FormFieldSchema, values: unknown[]): Record<string, unknown> {
  const indices = values.map((_, index) => index);
  const defaultValue = choiceDefault(field, values);
  const defaultEntry = defaultValue === undefined ? {} : { default: defaultValue };

  if (field['x-widget'] === 'checkboxes') {
    return {
      ...pickKeys(field, ['title', 'description']),
      type: 'array',
      items: { type: 'integer', enum: indices },
      ...pickKeys(field, ['minItems', 'maxItems']),
      ...defaultEntry,
    };
  }
  return { ...pickKeys(field, ['title', 'description']), type: 'integer', enum: indices, ...defaultEntry };
}

/** A schema without its x- keys, in it and in the schemas below it */
function withoutExtensionKeys(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !isExtensionKey(key))
    .map(([key, value]): [string, unknown] => {
      if (key === 'items' && isPlainObject(value)) return [key, withoutExtensionKeys(value)];
      if (key === 'properties' && isPlainObject(value)) {
        return [key, Object.fromEntries(Object.entries(value).map(([name, propertySchema]): [string, unknown] => [
          name,
          isPlainObject(propertySchema) ? withoutExtensionKeys(propertySchema) : propertySchema,
        ]))];
      }
      return [key, value];
    }));
}

function formFieldOf(
  name: string,
  widget: SchedulerFormWidget,
  schema: Record<string, unknown>,
  required: boolean,
  choices: SchedulerFormChoice[] | undefined,
): SchedulerFormField {
  const limits: Pick<SchedulerFormField, (typeof FIELD_LIMIT_KEYS)[number]> = {};
  for (const key of FIELD_LIMIT_KEYS) {
    const limit = schema[key];
    if (typeof limit === 'number') limits[key] = limit;
  }
  return {
    name,
    ...(typeof schema.title === 'string' ? { title: schema.title } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    widget,
    required,
    ...(choices === undefined ? {} : { choices }),
    ...limits,
    ...(Object.hasOwn(schema, 'default') ? { default: schema.default } : {}),
  };
}

/**
 * The fields of a definition in the order the form shows them: by x-order, the fields without one
 * after the others, then by name. The order of the keys is not kept by the database, so it is not used.
 */
function orderedFields(properties: Record<string, FormFieldSchema>): [string, FormFieldSchema][] {
  return Object.entries(properties).sort(([leftName, left], [rightName, right]) => {
    const leftOrder = left['x-order'] ?? Number.POSITIVE_INFINITY;
    const rightOrder = right['x-order'] ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;
    // By code unit, not by locale, so every run sorts the same
    if (leftName === rightName) return 0;
    return leftName < rightName ? -1 : 1;
  });
}

/**
 * Resolves the form a stage run shows from the definition of its stage and its input. The schema
 * takes no field the form does not have.
 */
export function resolveForm(definition: FormDefinition, input: unknown): FormResolution {
  const required = new Set(definition.required ?? []);
  const propertyEntries: [string, Record<string, unknown>][] = [];
  const fields: SchedulerFormField[] = [];
  const choiceValues = new Map<string, unknown[]>();

  for (const [name, field] of orderedFields(definition.properties)) {
    const widget = field['x-widget'];
    let schema: Record<string, unknown>;
    let choices: SchedulerFormChoice[] | undefined;

    if (CHOICE_WIDGETS.has(widget)) {
      const resolvedChoices = resolveChoices(field, input);
      if (resolvedChoices === undefined) return { resolved: false, fieldName: name };
      schema = choiceFieldSchema(field, resolvedChoices.values);
      choices = resolvedChoices.choices;
      choiceValues.set(name, resolvedChoices.values);
    } else {
      schema = withoutExtensionKeys(field);
    }

    propertyEntries.push([name, schema]);
    fields.push(formFieldOf(name, widget, schema, required.has(name), choices));
  }

  const schema: Record<string, unknown> = {
    ...pickKeys(definition, ['title', 'description']),
    type: 'object',
    // fromEntries keeps a field named __proto__ as a field
    properties: Object.fromEntries(propertyEntries),
    ...pickKeys(definition, ['required']),
    additionalProperties: false,
  };
  return { resolved: true, form: { schema, fields, choiceValues } };
}

/**
 * The first number an answer chooses twice in one checkboxes field, which the schema cannot say.
 */
export function findRepeatedChoice(
  form: SchedulerStageRunForm,
  answer: Record<string, unknown>,
): { path: string; reason: string } | undefined {
  for (const field of form.fields) {
    if (field.widget !== 'checkboxes' || !Object.hasOwn(answer, field.name)) continue;
    const chosen = answer[field.name];
    if (!Array.isArray(chosen)) continue;

    const seen = new Set<unknown>();
    for (let index = 0; index < chosen.length; index++) {
      if (seen.has(chosen[index])) {
        return { path: `${propertyPath('$', field.name)}[${index}]`, reason: 'is chosen more than once' };
      }
      seen.add(chosen[index]);
    }
  }
  return undefined;
}

/**
 * Maps an answer that matches the form to the output of the stage run: each number of a choice
 * becomes the value it stands for. The choices are resolved again from the input the stage run kept,
 * with the definition the stage has now; when they are not the ones the form showed (the stage was
 * edited since), the answer is not mapped.
 */
export function mapAnswer(
  definition: FormDefinition,
  form: SchedulerStageRunForm,
  input: unknown,
  answer: Record<string, unknown>,
): AnswerMapping {
  const resolution = resolveForm(definition, input);
  if (!resolution.resolved) return { mapped: false };

  const { choiceValues, fields } = resolution.form;
  const shownChoiceFields = form.fields.filter((field) => field.choices !== undefined);
  if (shownChoiceFields.length !== choiceValues.size) return { mapped: false };
  for (const shownField of shownChoiceFields) {
    const field = fields.find((candidate) => candidate.name === shownField.name);
    if (field === undefined || field.widget !== shownField.widget || !isDeepEqual(field.choices, shownField.choices)) {
      return { mapped: false };
    }
  }

  const output = Object.fromEntries(Object.entries(answer).map(([name, value]): [string, unknown] => {
    const values = choiceValues.get(name);
    if (values === undefined) return [name, value];
    if (Array.isArray(value)) return [name, value.map((index) => values[index as number])];
    return [name, values[value as number]];
  }));
  return { mapped: true, output };
}
