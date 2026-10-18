/**
 * Input fields for the settings of a task group stage, made from the settings format the group
 * registered, and the conversions between what is typed into them and the settings sent to the
 * server. The server checks the settings against the format; these functions only read the input.
 */

export type SettingsFieldKind = 'select' | 'text' | 'number' | 'boolean' | 'json';

export interface SettingsField {
  name: string;
  // The title of the property, or its name
  label: string;
  description: string | undefined;
  required: boolean;
  kind: SettingsFieldKind;
  // The enum values of a select field
  options: unknown[];
  defaultValue: unknown;
}

// A select field holds the JSON text of its option ('' for none) and a boolean field whether it is checked
export type SettingsInputValues = Record<string, string | boolean>;

export type SettingsResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: string };

export interface SettingsEditorState {
  inputValues: SettingsInputValues;
  settingsJSON: string;
  // Always true for a format without fields, whose settings are written as one JSON object
  isEditingJSON: boolean;
  // Values the current fields do not show, such as those of a field another version has, kept so
  // that a format with that field gets them back. They are never sent.
  hiddenSettings: Record<string, unknown>;
}

export type SettingsEditorStateResult =
  | { ok: true; state: SettingsEditorState }
  | { ok: false; error: string };

type InputValueReading =
  | { status: 'empty' }
  | { status: 'value'; value: unknown }
  | { status: 'invalid'; error: string };

const NUMBER_PATTERN = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveFieldKind(schema: Record<string, unknown>): SettingsFieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return 'select';
  }
  switch (schema.type) {
    case 'string':
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'json';
  }
}

/**
 * One field for each top-level property of the format, in the order of its properties.
 *
 * @returns undefined when the format is not an object with properties, so that the settings are
 * written as one JSON object
 */
export function buildSettingsFields(schema: Record<string, unknown>): SettingsField[] | undefined {
  if (schema.type !== 'object' || !isPlainObject(schema.properties)) {
    return undefined;
  }
  const requiredNames = Array.isArray(schema.required) ? schema.required : [];

  return Object.entries(schema.properties).map(([name, property]) => {
    const propertySchema = isPlainObject(property) ? property : {};
    return {
      name,
      label: typeof propertySchema.title === 'string' && propertySchema.title.length > 0 ? propertySchema.title : name,
      description: typeof propertySchema.description === 'string' ? propertySchema.description : undefined,
      required: requiredNames.includes(name),
      kind: resolveFieldKind(propertySchema),
      options: Array.isArray(propertySchema.enum) ? propertySchema.enum : [],
      defaultValue: propertySchema.default,
    };
  });
}

/**
 * The settings of a new stage: the default of each field that has one.
 */
export function defaultSettings(fields: SettingsField[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      settings[field.name] = field.defaultValue;
    }
  }
  return settings;
}

export function formatOptionLabel(option: unknown): string {
  return typeof option === 'string' ? option : JSON.stringify(option);
}

function toInputValue(field: SettingsField, value: unknown): string | boolean {
  switch (field.kind) {
    case 'boolean':
      return value === true;
    case 'select': {
      if (value === undefined) return '';
      const optionKey = JSON.stringify(value);
      // A value the format does not offer leaves the field empty
      return field.options.some((option) => JSON.stringify(option) === optionKey) ? optionKey : '';
    }
    case 'text':
    case 'number':
      if (value === undefined) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'json':
      return value === undefined ? '' : JSON.stringify(value, null, 2);
  }
}

function readInputValue(field: SettingsField, inputValue: string | boolean | undefined): InputValueReading {
  if (field.kind === 'boolean') {
    return { status: 'value', value: inputValue === true };
  }

  const text = typeof inputValue === 'string' ? inputValue : '';
  switch (field.kind) {
    case 'select':
      if (text === '') return { status: 'empty' };
      try {
        return { status: 'value', value: JSON.parse(text) };
      } catch {
        return { status: 'empty' };
      }
    case 'text':
      return text === '' ? { status: 'empty' } : { status: 'value', value: text };
    case 'number': {
      const trimmed = text.trim();
      if (trimmed === '') return { status: 'empty' };
      if (!NUMBER_PATTERN.test(trimmed)) {
        return { status: 'invalid', error: `Setting '${field.label}' must be a number.` };
      }
      return { status: 'value', value: Number(trimmed) };
    }
    case 'json': {
      const trimmed = text.trim();
      if (trimmed === '') return { status: 'empty' };
      try {
        return { status: 'value', value: JSON.parse(trimmed) };
      } catch {
        return { status: 'invalid', error: `Setting '${field.label}' must be valid JSON.` };
      }
    }
  }
}

/**
 * The input value of each field. Settings the fields do not name are left out.
 */
export function settingsToInputValues(fields: SettingsField[], settings: Record<string, unknown>): SettingsInputValues {
  const inputValues: SettingsInputValues = {};
  for (const field of fields) {
    inputValues[field.name] = toInputValue(field, settings[field.name]);
  }
  return inputValues;
}

/**
 * The settings the fields hold. An empty field is left out and a checkbox is always true or false.
 *
 * @returns the error of the first field whose number or JSON cannot be read
 */
export function inputValuesToSettings(fields: SettingsField[], inputValues: SettingsInputValues): SettingsResult {
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    const reading = readInputValue(field, inputValues[field.name]);
    if (reading.status === 'invalid') {
      return { ok: false, error: reading.error };
    }
    if (reading.status === 'value') {
      settings[field.name] = reading.value;
    }
  }
  return { ok: true, settings };
}

export function parseSettingsJSON(settingsJSON: string): SettingsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJSON);
  } catch {
    return { ok: false, error: 'Invalid JSON in settings.' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Settings must be a JSON object.' };
  }
  return { ok: true, settings: parsed };
}

function formatSettingsJSON(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2);
}

function omitFieldSettings(settings: Record<string, unknown>, fields: SettingsField[]): Record<string, unknown> {
  const fieldNames = new Set(fields.map((field) => field.name));
  return Object.fromEntries(Object.entries(settings).filter(([name]) => !fieldNames.has(name)));
}

export function createSettingsEditorState(
  fields: SettingsField[] | undefined,
  settings: Record<string, unknown>,
): SettingsEditorState {
  if (fields === undefined) {
    return { inputValues: {}, settingsJSON: formatSettingsJSON(settings), isEditingJSON: true, hiddenSettings: {} };
  }
  return {
    inputValues: settingsToInputValues(fields, settings),
    settingsJSON: '',
    isEditingJSON: false,
    hiddenSettings: omitFieldSettings(settings, fields),
  };
}

export function readSettingsEditorState(fields: SettingsField[] | undefined, state: SettingsEditorState): SettingsResult {
  if (fields === undefined || state.isEditingJSON) {
    return parseSettingsJSON(state.settingsJSON);
  }
  return inputValuesToSettings(fields, state.inputValues);
}

/**
 * Edit JSON: the settings of the fields as one JSON object.
 */
export function startEditingSettingsJSON(fields: SettingsField[], state: SettingsEditorState): SettingsEditorStateResult {
  const result = inputValuesToSettings(fields, state.inputValues);
  if (!result.ok) {
    return result;
  }
  return { ok: true, state: { ...state, settingsJSON: formatSettingsJSON(result.settings), isEditingJSON: true } };
}

/**
 * Simple mode: the fields filled again from the JSON, which must be an object. A field the JSON
 * leaves out gets its hidden value, if it has one.
 */
export function stopEditingSettingsJSON(fields: SettingsField[], state: SettingsEditorState): SettingsEditorStateResult {
  const result = parseSettingsJSON(state.settingsJSON);
  if (!result.ok) {
    return result;
  }
  const knownSettings = { ...state.hiddenSettings, ...result.settings };
  return {
    ok: true,
    state: {
      ...state,
      inputValues: settingsToInputValues(fields, knownSettings),
      isEditingJSON: false,
      hiddenSettings: omitFieldSettings(knownSettings, fields),
    },
  };
}

/**
 * The editor for another version's format. A field keeps the value of the field with the same
 * name, or else the value it had when an earlier format showed it, and otherwise starts at its
 * default. JSON being written stays as it is; Simple mode fills the new fields from it.
 */
export function changeSettingsFormat(
  previousFields: SettingsField[] | undefined,
  state: SettingsEditorState,
  nextFields: SettingsField[] | undefined,
): SettingsEditorState {
  if (previousFields === undefined || state.isEditingJSON) {
    return { ...state, isEditingJSON: true };
  }

  const previousFieldsByName = new Map(previousFields.map((field) => [field.name, field]));
  // What each field holds now; an emptied field forgets its hidden value
  const knownSettings = { ...state.hiddenSettings };
  const previousSettings: Record<string, unknown> = {};
  for (const field of previousFields) {
    // A value that cannot be read is dropped rather than blocking the change
    const reading = readInputValue(field, state.inputValues[field.name]);
    if (reading.status === 'value') {
      knownSettings[field.name] = reading.value;
      previousSettings[field.name] = reading.value;
    } else {
      delete knownSettings[field.name];
    }
  }

  if (nextFields === undefined) {
    return {
      inputValues: {},
      settingsJSON: formatSettingsJSON(previousSettings),
      isEditingJSON: true,
      hiddenSettings: omitFieldSettings(knownSettings, previousFields),
    };
  }

  const carriedSettings: Record<string, unknown> = {};
  for (const field of nextFields) {
    if (Object.hasOwn(knownSettings, field.name)) {
      carriedSettings[field.name] = knownSettings[field.name];
    } else if (!previousFieldsByName.has(field.name) && field.defaultValue !== undefined) {
      carriedSettings[field.name] = field.defaultValue;
    }
  }

  const inputValues = settingsToInputValues(nextFields, carriedSettings);
  for (const field of nextFields) {
    const previousField = previousFieldsByName.get(field.name);
    // Text of a field of the same kind stays exactly as typed, even when it cannot be read yet
    if (previousField !== undefined && previousField.kind === field.kind && field.kind !== 'select') {
      inputValues[field.name] = state.inputValues[field.name] ?? inputValues[field.name];
    }
  }
  return { ...state, inputValues, hiddenSettings: omitFieldSettings(knownSettings, nextFields) };
}
