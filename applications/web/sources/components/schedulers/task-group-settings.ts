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
  // The settings the fields were last filled from. The fields edit the keys the format lists; every
  // other key, such as one only another version lists or one added in Edit JSON, is kept and sent.
  settings: Record<string, unknown>;
  // What each field showed when it was filled, which tells the fields the user changed
  filledInputValues: SettingsInputValues;
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

/**
 * The settings with what the fields hold: each field puts its value in its key, and the keys the
 * fields do not list follow as they are. Only a field the user emptied removes its key; a field
 * that cannot show the value of its key, such as a select that does not offer it, leaves the key
 * as it is until the user changes the field.
 *
 * @param addsUnchangedValues whether a field the user did not change adds what it shows, such as its
 * default or an unchecked box, for a key the settings do not hold: true when the settings are read
 * to be sent, false when the fields give way to another format
 * @returns the error of the first field whose number or JSON cannot be read
 */
function applyInputValues(
  fields: SettingsField[],
  state: SettingsEditorState,
  addsUnchangedValues: boolean,
): { settings: Record<string, unknown>; error: string | undefined } {
  const entries: [string, unknown][] = [];
  let error: string | undefined;
  for (const field of fields) {
    const inputValue = state.inputValues[field.name];
    const isHeld = Object.hasOwn(state.settings, field.name);
    const isChanged = inputValue !== state.filledInputValues[field.name];
    // A default or an unchecked box the user left as it was
    if (!isChanged && !isHeld && !addsUnchangedValues) {
      continue;
    }
    const reading = readInputValue(field, inputValue);
    if (reading.status === 'value') {
      entries.push([field.name, reading.value]);
      continue;
    }
    if (reading.status === 'invalid') {
      error ??= reading.error;
    }
    // Only emptying a field removes its key
    if (isHeld && (reading.status === 'invalid' || !isChanged)) {
      entries.push([field.name, state.settings[field.name]]);
    }
  }
  const fieldNames = new Set(fields.map((field) => field.name));
  for (const [name, value] of Object.entries(state.settings)) {
    if (!fieldNames.has(name)) {
      entries.push([name, value]);
    }
  }
  return { settings: Object.fromEntries(entries), error };
}

/**
 * @param shownSettings what the fields show, which may add defaults to the settings
 */
function fillSettingsEditorState(
  fields: SettingsField[] | undefined,
  settings: Record<string, unknown>,
  shownSettings: Record<string, unknown>,
): SettingsEditorState {
  if (fields === undefined) {
    return { inputValues: {}, settingsJSON: formatSettingsJSON(settings), isEditingJSON: true, settings, filledInputValues: {} };
  }
  const inputValues = settingsToInputValues(fields, shownSettings);
  return { inputValues, settingsJSON: '', isEditingJSON: false, settings, filledInputValues: inputValues };
}

export function createSettingsEditorState(
  fields: SettingsField[] | undefined,
  settings: Record<string, unknown>,
): SettingsEditorState {
  return fillSettingsEditorState(fields, settings, settings);
}

/**
 * The editor of a new stage, whose fields start at their defaults. A default is sent with the
 * stage, but a field left at it does not follow to another version.
 */
export function createNewSettingsEditorState(fields: SettingsField[] | undefined): SettingsEditorState {
  return fillSettingsEditorState(fields, {}, fields === undefined ? {} : defaultSettings(fields));
}

/**
 * The settings to send: what the fields hold, and every key the format does not list as it is.
 */
export function readSettingsEditorState(fields: SettingsField[] | undefined, state: SettingsEditorState): SettingsResult {
  if (fields === undefined || state.isEditingJSON) {
    return parseSettingsJSON(state.settingsJSON);
  }
  const result = applyInputValues(fields, state, true);
  return result.error === undefined ? { ok: true, settings: result.settings } : { ok: false, error: result.error };
}

/**
 * Edit JSON: the settings to send as one JSON object, keys the format does not list included.
 */
export function startEditingSettingsJSON(fields: SettingsField[], state: SettingsEditorState): SettingsEditorStateResult {
  const result = readSettingsEditorState(fields, state);
  if (!result.ok) {
    return result;
  }
  return { ok: true, state: { ...state, settingsJSON: formatSettingsJSON(result.settings), isEditingJSON: true } };
}

/**
 * Simple mode: the JSON, which must be an object, becomes the settings and fills the fields. A key
 * the JSON leaves out is gone; one the format does not list is kept.
 */
export function stopEditingSettingsJSON(fields: SettingsField[], state: SettingsEditorState): SettingsEditorStateResult {
  const result = parseSettingsJSON(state.settingsJSON);
  if (!result.ok) {
    return result;
  }
  return { ok: true, state: createSettingsEditorState(fields, result.settings) };
}

/**
 * The editor for another version's format. Every key is kept, and a field of the new format shows
 * the value of its key, or else starts at its default when the previous format did not list it. A
 * field both formats list keeps what it showed, such as a default or text that cannot be read yet;
 * a select keeps its option only when the new format offers it. A field the user did not change
 * stays unchanged and adds nothing, so a default or an unchecked box it showed does not become a
 * setting of the new version, however many versions it goes through. JSON being written stays as it
 * is; Simple mode fills the new fields from it.
 */
export function changeSettingsFormat(
  previousFields: SettingsField[] | undefined,
  state: SettingsEditorState,
  nextFields: SettingsField[] | undefined,
): SettingsEditorState {
  if (previousFields === undefined || state.isEditingJSON) {
    return { ...state, isEditingJSON: true };
  }

  // A value that cannot be read leaves its key as it was rather than blocking the change
  const { settings } = applyInputValues(previousFields, state, false);
  if (nextFields === undefined) {
    return createSettingsEditorState(undefined, settings);
  }

  const previousFieldsByName = new Map(previousFields.map((field) => [field.name, field]));
  const defaults = defaultSettings(nextFields.filter((field) => !previousFieldsByName.has(field.name)));
  const nextState = fillSettingsEditorState(nextFields, settings, { ...defaults, ...settings });
  const inputValues = { ...nextState.inputValues };
  const filledInputValues = { ...nextState.filledInputValues };
  for (const field of nextFields) {
    const previousField = previousFieldsByName.get(field.name);
    const inputValue = state.inputValues[field.name];
    if (previousField === undefined || previousField.kind !== field.kind || inputValue === undefined) {
      continue;
    }
    if (field.kind !== 'select') {
      // Text of a field of the same kind stays exactly as typed, even when it cannot be read yet
      inputValues[field.name] = inputValue;
    } else if (!Object.hasOwn(settings, field.name) && field.options.some((option) => JSON.stringify(option) === inputValue)) {
      // A select without a key, such as one left at its default, keeps the option it showed
      inputValues[field.name] = inputValue;
    }
    // A field the user did not change stays so, and a default it still shows does not follow to another version
    if (inputValue === state.filledInputValues[field.name]) {
      filledInputValues[field.name] = inputValues[field.name];
    }
  }
  return { ...nextState, inputValues, filledInputValues };
}
