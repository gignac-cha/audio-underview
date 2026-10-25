import type { SchedulerFormWidget } from '@audio-underview/supabase-connector';
import { UnsupportedSchemaError, assertSchemaSupported, isExtensionKey, propertyPath } from './schema-validation.ts';

/**
 * The definition of a form stage, kept in its settings as { form, timeout_minutes? }. form is the
 * JSON Schema of the answer: an object whose fields each name how they are drawn (x-widget) and
 * may name their place in the form (x-order), and a choice field may take its choices from the
 * input of the stage (x-options). The definition is checked when the stage is saved; the form a
 * stage run shows is resolved from it when the run reaches the stage (form-resolution.ts).
 */

export const FORM_WIDGETS: readonly SchedulerFormWidget[] = ['checkboxes', 'radio', 'select', 'text', 'textarea', 'number', 'toggle'];

/** The widgets whose answer is the number of a choice, or for checkboxes an array of them */
export const CHOICE_WIDGETS: ReadonlySet<SchedulerFormWidget> = new Set<SchedulerFormWidget>(['checkboxes', 'radio', 'select']);

export const DEFAULT_FORM_TIMEOUT_MINUTES = 1440;
// 365 days
export const MAXIMUM_FORM_TIMEOUT_MINUTES = 525_600;

/**
 * Where the choices of a field come from: the items of an array in the input of the stage
 */
export interface FormChoiceOptions {
  /** '$' for the input itself, or '$.<path>' to an array inside it */
  from: string;
  /** Path inside an item to its label, or '$' for the item itself */
  label: string;
  /** Path inside an item to its description */
  description?: string;
  /** Path inside an item to the value a choice of it stands for; the whole item when absent */
  value?: string;
}

/** One field of a form definition, already checked */
export type FormFieldSchema = Record<string, unknown> & {
  'x-widget': SchedulerFormWidget;
  'x-options'?: FormChoiceOptions;
  /** The place of the field in the form, smallest first; the database does not keep the order of the keys */
  'x-order'?: number;
};

/** A form definition, already checked */
export interface FormDefinition {
  [key: string]: unknown;
  type: 'object';
  properties: Record<string, FormFieldSchema>;
  required?: string[];
  title?: string;
  description?: string;
}

export interface FormStageSettings {
  form: FormDefinition;
  timeoutMinutes: number;
}

export type FormStageSettingsCheck =
  | { valid: true; settings: FormStageSettings }
  /** description is the error description of the request that saves the settings */
  | { valid: false; description: string };

const SETTINGS_KEYS: ReadonlySet<string> = new Set(['form', 'timeout_minutes']);
const FORM_KEYS: ReadonlySet<string> = new Set(['type', 'properties', 'required', 'title', 'description']);
const FIELD_EXTENSION_KEYS: ReadonlySet<string> = new Set(['x-widget', 'x-options', 'x-order']);
const CHOICE_OPTIONS_KEYS: ReadonlySet<string> = new Set(['from', 'label', 'description', 'value']);

// A path is made of names of properties or numbers of array items, separated by dots
const PATH_SEGMENT = '[A-Za-z0-9_-]+';
const FROM_PATH_PATTERN = new RegExp(`^\\$(?:\\.${PATH_SEGMENT})*$`);
const ITEM_PATH_PATTERN = new RegExp(`^(?:\\$|${PATH_SEGMENT}(?:\\.${PATH_SEGMENT})*)$`);

/**
 * A part of the definition breaks a form rule. path is where, as validation results write it.
 */
class FormDefinitionError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'FormDefinitionError';
    this.path = path;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeoutMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAXIMUM_FORM_TIMEOUT_MINUTES;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFormWidget(value: unknown): value is SchedulerFormWidget {
  return typeof value === 'string' && (FORM_WIDGETS as readonly string[]).includes(value);
}

function assertNoExtensionKeys(schema: unknown, path: string): void {
  if (!isPlainObject(schema)) return;
  const extensionKey = Object.keys(schema).find(isExtensionKey);
  if (extensionKey !== undefined) {
    throw new FormDefinitionError(path, `must not have '${extensionKey}': only the fields of a form take x-widget, x-options and x-order`);
  }
  if (Object.hasOwn(schema, 'items')) assertNoExtensionKeys(schema.items, `${path}.items`);
  if (isPlainObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      assertNoExtensionKeys(propertySchema, propertyPath(`${path}.properties`, name));
    }
  }
}

function assertChoiceOptions(options: unknown, path: string): asserts options is FormChoiceOptions {
  if (!isPlainObject(options)) {
    throw new FormDefinitionError(path, 'must be a JSON object');
  }
  const unknownKey = Object.keys(options).find((key) => !CHOICE_OPTIONS_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new FormDefinitionError(path, `must not have '${unknownKey}'`);
  }
  if (typeof options.from !== 'string' || !FROM_PATH_PATTERN.test(options.from)) {
    throw new FormDefinitionError(`${path}.from`, "must be '$' or a path that starts with '$.'");
  }
  if (typeof options.label !== 'string' || !ITEM_PATH_PATTERN.test(options.label)) {
    throw new FormDefinitionError(`${path}.label`, "must be '$' or a path inside an item");
  }
  for (const key of ['description', 'value'] as const) {
    if (!Object.hasOwn(options, key)) continue;
    const itemPath = options[key];
    if (typeof itemPath !== 'string' || !ITEM_PATH_PATTERN.test(itemPath)) {
      throw new FormDefinitionError(`${path}.${key}`, "must be '$' or a path inside an item");
    }
  }
}

/**
 * Checks the widget of a field and the type and choices the widget needs.
 */
function assertFormField(field: Record<string, unknown>, path: string): void {
  const unknownExtensionKey = Object.keys(field).find((key) => isExtensionKey(key) && !FIELD_EXTENSION_KEYS.has(key));
  if (unknownExtensionKey !== undefined) {
    throw new FormDefinitionError(path, `must not have '${unknownExtensionKey}'`);
  }

  const widget = field['x-widget'];
  if (!isFormWidget(widget)) {
    throw new FormDefinitionError(path, `must have x-widget, one of: ${FORM_WIDGETS.join(', ')}`);
  }

  if (Object.hasOwn(field, 'x-order') && !isNonNegativeInteger(field['x-order'])) {
    throw new FormDefinitionError(propertyPath(path, 'x-order'), 'must be a non-negative integer');
  }

  const hasOptions = Object.hasOwn(field, 'x-options');
  if (hasOptions) {
    if (!CHOICE_WIDGETS.has(widget)) {
      throw new FormDefinitionError(path, 'must not have x-options: only checkboxes, radio and select take choices');
    }
    assertChoiceOptions(field['x-options'], propertyPath(path, 'x-options'));
  }

  if (Object.hasOwn(field, 'format') && widget !== 'text') {
    throw new FormDefinitionError(path, "must not have format: only x-widget 'text' takes format 'uri'");
  }

  if (Object.hasOwn(field, 'items')) assertNoExtensionKeys(field.items, `${path}.items`);
  if (isPlainObject(field.properties)) {
    for (const [name, propertySchema] of Object.entries(field.properties)) {
      assertNoExtensionKeys(propertySchema, propertyPath(`${path}.properties`, name));
    }
  }

  switch (widget) {
    case 'checkboxes': {
      if (field.type !== 'array') {
        throw new FormDefinitionError(path, "must have type 'array' for x-widget 'checkboxes'");
      }
      const hasItemsEnum = isPlainObject(field.items) && Object.hasOwn(field.items, 'enum');
      if (hasOptions && hasItemsEnum) {
        throw new FormDefinitionError(path, 'must take its choices from x-options or items.enum, not both');
      }
      if (!hasOptions && !hasItemsEnum) {
        throw new FormDefinitionError(path, "must take its choices from x-options or items.enum for x-widget 'checkboxes'");
      }
      return;
    }
    case 'radio':
    case 'select': {
      const hasEnum = Object.hasOwn(field, 'enum');
      if (hasOptions && hasEnum) {
        throw new FormDefinitionError(path, 'must take its choices from x-options or enum, not both');
      }
      if (!hasOptions && !hasEnum) {
        throw new FormDefinitionError(path, `must take its choices from x-options or enum for x-widget '${widget}'`);
      }
      return;
    }
    case 'text':
    case 'textarea':
      if (field.type !== 'string') {
        throw new FormDefinitionError(path, `must have type 'string' for x-widget '${widget}'`);
      }
      return;
    case 'number':
      if (field.type !== 'number' && field.type !== 'integer') {
        throw new FormDefinitionError(path, "must have type 'number' or 'integer' for x-widget 'number'");
      }
      return;
    case 'toggle':
      if (field.type !== 'boolean') {
        throw new FormDefinitionError(path, "must have type 'boolean' for x-widget 'toggle'");
      }
      return;
  }
}

/**
 * Checks a form definition: a schema the scheduler can read, an object of at least one field at the
 * top, and fields whose widgets fit their types.
 *
 * @throws FormDefinitionError or UnsupportedSchemaError
 */
function assertFormDefinition(form: unknown): asserts form is FormDefinition {
  assertSchemaSupported(form);

  const unknownKey = Object.keys(form).find((key) => !FORM_KEYS.has(key));
  if (unknownKey !== undefined) {
    throw new FormDefinitionError('$', `must not have '${unknownKey}'`);
  }
  if (form.type !== 'object') {
    throw new FormDefinitionError('$', "must have type 'object'");
  }
  // assertSchemaSupported made properties an object of schemas, if it is there
  const properties = (form.properties ?? {}) as Record<string, Record<string, unknown>>;
  if (Object.keys(properties).length === 0) {
    throw new FormDefinitionError('$.properties', 'must have at least one field');
  }
  for (const name of (form.required ?? []) as string[]) {
    if (!Object.hasOwn(properties, name)) {
      throw new FormDefinitionError('$.required', `names '${name}', which is not a field`);
    }
  }

  for (const [name, field] of Object.entries(properties)) {
    assertFormField(field, propertyPath('$.properties', name));
  }
}

/**
 * Checks the settings of a form stage: { form, timeout_minutes? }, and nothing else.
 *
 * @returns the form definition and the timeout, the default one when the settings have none
 */
export function checkFormStageSettings(settings: unknown): FormStageSettingsCheck {
  if (!isPlainObject(settings)) {
    return { valid: false, description: "Field 'settings' must be a JSON object" };
  }
  const unknownKey = Object.keys(settings).find((key) => !SETTINGS_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { valid: false, description: `Field 'settings.${unknownKey}' is not allowed on a form stage` };
  }

  const { form, timeout_minutes: timeoutMinutes } = settings;
  if (!isPlainObject(form)) {
    return { valid: false, description: "Field 'settings.form' is required and must be a JSON object" };
  }
  if (timeoutMinutes !== undefined && !isTimeoutMinutes(timeoutMinutes)) {
    return {
      valid: false,
      description: `Field 'settings.timeout_minutes' must be an integer from 1 to ${MAXIMUM_FORM_TIMEOUT_MINUTES}`,
    };
  }

  try {
    assertFormDefinition(form);
  } catch (error) {
    if (error instanceof FormDefinitionError) {
      return { valid: false, description: `Field 'settings.form' is not a valid form: ${error.path} ${error.message}` };
    }
    if (error instanceof UnsupportedSchemaError) {
      return { valid: false, description: `Field 'settings.form' is not a valid form: ${error.message}` };
    }
    throw error;
  }

  return { valid: true, settings: { form, timeoutMinutes: timeoutMinutes ?? DEFAULT_FORM_TIMEOUT_MINUTES } };
}
