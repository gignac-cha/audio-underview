import { describe, test, expect } from 'vitest';
import {
  buildSettingsFields,
  changeSettingsFormat,
  createSettingsEditorState,
  defaultSettings,
  inputValuesToSettings,
  parseSettingsJSON,
  readSettingsEditorState,
  settingsToInputValues,
  startEditingSettingsJSON,
  stopEditingSettingsJSON,
  type SettingsField,
} from './task-group-settings.ts';

const NEWSCAST_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', title: 'Title', description: 'Shown above the episode' },
    voice: { enum: ['calm', 'bright', 1, null], default: 'calm' },
    length: { type: 'integer', default: 5 },
    speed: { type: 'number' },
    music: { type: 'boolean', default: true },
    tags: { type: 'array', items: { type: 'string' } },
    extra: { type: 'object' },
    either: { type: ['string', 'number'] },
    anything: {},
  },
};

function fieldsOf(schema: Record<string, unknown>): SettingsField[] {
  const fields = buildSettingsFields(schema);
  if (fields === undefined) throw new Error('Expected fields');
  return fields;
}

function fieldNamed(fields: SettingsField[], name: string): SettingsField {
  const field = fields.find((candidate) => candidate.name === name);
  if (field === undefined) throw new Error(`No field ${name}`);
  return field;
}

describe('buildSettingsFields', () => {
  test('gives each property the field of its format', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    expect(fields.map((field) => [field.name, field.kind])).toEqual([
      ['title', 'text'],
      ['voice', 'select'],
      ['length', 'number'],
      ['speed', 'number'],
      ['music', 'boolean'],
      ['tags', 'json'],
      ['extra', 'json'],
      ['either', 'json'],
      ['anything', 'json'],
    ]);
  });

  test('takes the label from the title, then the name', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    expect(fieldNamed(fields, 'title').label).toBe('Title');
    expect(fieldNamed(fields, 'voice').label).toBe('voice');
  });

  test('carries the description, whether the field is required, the options and the default', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    expect(fieldNamed(fields, 'title')).toMatchObject({ description: 'Shown above the episode', required: true });
    expect(fieldNamed(fields, 'voice')).toMatchObject({
      description: undefined,
      required: false,
      options: ['calm', 'bright', 1, null],
      defaultValue: 'calm',
    });
    expect(fieldNamed(fields, 'length').defaultValue).toBe(5);
  });

  test('a select wins over the type', () => {
    const fields = fieldsOf({ type: 'object', properties: { level: { type: 'integer', enum: [1, 2] } } });

    expect(fields[0].kind).toBe('select');
  });

  test.each([
    ['an array format', { type: 'array' }],
    ['an object without properties', { type: 'object' }],
    ['properties without the object type', { properties: { title: { type: 'string' } } }],
  ])('has no fields for %s', (_name, schema) => {
    expect(buildSettingsFields(schema)).toBeUndefined();
  });
});

describe('defaultSettings', () => {
  test('holds the defaults of the fields that have one', () => {
    expect(defaultSettings(fieldsOf(NEWSCAST_SCHEMA))).toEqual({ voice: 'calm', length: 5, music: true });
  });
});

describe('inputValuesToSettings', () => {
  test('reads each kind of field', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    const result = inputValuesToSettings(fields, {
      title: 'Morning',
      voice: '1',
      length: '7',
      speed: ' 1.5 ',
      music: false,
      tags: '["news", "daily"]',
      extra: '{"a": 1}',
      either: '"text"',
      anything: 'null',
    });

    expect(result).toEqual({
      ok: true,
      settings: {
        title: 'Morning',
        voice: 1,
        length: 7,
        speed: 1.5,
        music: false,
        tags: ['news', 'daily'],
        extra: { a: 1 },
        either: 'text',
        anything: null,
      },
    });
  });

  test('leaves empty fields out but always sends a checkbox', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    const result = inputValuesToSettings(fields, {
      title: '',
      voice: '',
      length: '  ',
      speed: '',
      music: true,
      tags: '',
      extra: '',
      either: '',
      anything: '',
    });

    expect(result).toEqual({ ok: true, settings: { music: true } });
  });

  test('sends an unchecked checkbox as false', () => {
    const fields = fieldsOf({ type: 'object', properties: { music: { type: 'boolean' } } });

    expect(inputValuesToSettings(fields, {})).toEqual({ ok: true, settings: { music: false } });
  });

  test.each(['abc', '1.2.3', '0x10', 'Infinity', '1e'])('rejects %s in a number field', (inputValue) => {
    const fields = fieldsOf({ type: 'object', properties: { speed: { type: 'number', title: 'Speed' } } });

    expect(inputValuesToSettings(fields, { speed: inputValue })).toEqual({
      ok: false,
      error: "Setting 'Speed' must be a number.",
    });
  });

  test('rejects text that is not JSON in a JSON field', () => {
    const fields = fieldsOf({ type: 'object', properties: { tags: { type: 'array' } } });

    expect(inputValuesToSettings(fields, { tags: '[news' })).toEqual({
      ok: false,
      error: "Setting 'tags' must be valid JSON.",
    });
  });
});

describe('settingsToInputValues', () => {
  test('fills each field from the settings', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    expect(settingsToInputValues(fields, { title: 'Morning', voice: null, length: 3, music: true, tags: ['a'] })).toEqual({
      title: 'Morning',
      voice: 'null',
      length: '3',
      speed: '',
      music: true,
      tags: JSON.stringify(['a'], null, 2),
      extra: '',
      either: '',
      anything: '',
    });
  });

  test('leaves a select empty for a value it does not offer', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);

    expect(settingsToInputValues(fields, { voice: 'loud' }).voice).toBe('');
  });

  test('settings come back unchanged through the fields', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);
    const settings = {
      title: 'Morning',
      voice: 'bright',
      length: 0,
      speed: -2.5,
      music: false,
      tags: ['news', 'daily'],
      extra: { nested: { deep: [1, 2] } },
      either: 3,
      anything: null,
    };

    expect(inputValuesToSettings(fields, settingsToInputValues(fields, settings))).toEqual({ ok: true, settings });
  });
});

describe('parseSettingsJSON', () => {
  test('reads a JSON object', () => {
    expect(parseSettingsJSON('{"title": "Morning"}')).toEqual({ ok: true, settings: { title: 'Morning' } });
  });

  test.each(['[]', '"text"', 'null', '3'])('rejects %s, which is not an object', (settingsJSON) => {
    expect(parseSettingsJSON(settingsJSON)).toEqual({ ok: false, error: 'Settings must be a JSON object.' });
  });

  test('rejects text that is not JSON', () => {
    expect(parseSettingsJSON('{title')).toEqual({ ok: false, error: 'Invalid JSON in settings.' });
  });
});

describe('settings editor state', () => {
  test('a format without fields is written as one JSON object', () => {
    const state = createSettingsEditorState(undefined, { title: 'Morning' });

    expect(state.isEditingJSON).toBe(true);
    expect(readSettingsEditorState(undefined, state)).toEqual({ ok: true, settings: { title: 'Morning' } });
  });

  test('Edit JSON shows the settings of the fields and Simple mode fills the fields from the JSON', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);
    const state = createSettingsEditorState(fields, { title: 'Morning', music: true });

    const editing = startEditingSettingsJSON(fields, state);
    if (!editing.ok) throw new Error(editing.error);
    expect(JSON.parse(editing.state.settingsJSON)).toEqual({ title: 'Morning', music: true });

    const stopped = stopEditingSettingsJSON(fields, { ...editing.state, settingsJSON: '{"title": "Evening", "length": 9}' });
    if (!stopped.ok) throw new Error(stopped.error);
    expect(stopped.state.isEditingJSON).toBe(false);
    expect(readSettingsEditorState(fields, stopped.state)).toEqual({
      ok: true,
      settings: { title: 'Evening', length: 9, music: false },
    });
  });

  test('Edit JSON is refused while a field cannot be read', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);
    const state = createSettingsEditorState(fields, {});

    const result = startEditingSettingsJSON(fields, { ...state, inputValues: { ...state.inputValues, speed: 'fast' } });

    expect(result).toEqual({ ok: false, error: "Setting 'speed' must be a number." });
  });

  test('Simple mode is refused while the JSON is not an object', () => {
    const fields = fieldsOf(NEWSCAST_SCHEMA);
    const state = { ...createSettingsEditorState(fields, {}), isEditingJSON: true, settingsJSON: '["title"]' };

    expect(stopEditingSettingsJSON(fields, state)).toEqual({ ok: false, error: 'Settings must be a JSON object.' });
  });
});

describe('changeSettingsFormat', () => {
  const versionOne = fieldsOf({
    type: 'object',
    properties: {
      title: { type: 'string' },
      voice: { enum: ['calm', 'bright'] },
      length: { type: 'integer' },
      speed: { type: 'string' },
      dropped: { type: 'string' },
    },
  });
  const versionTwo = fieldsOf({
    type: 'object',
    properties: {
      title: { type: 'string' },
      voice: { enum: ['calm', 'loud'] },
      length: { type: 'integer' },
      speed: { type: 'number' },
      music: { type: 'boolean', default: true },
    },
  });

  test('keeps the values of fields with the same name and starts new fields at their default', () => {
    const state = createSettingsEditorState(versionOne, { title: 'Morning', voice: 'calm', speed: '2', dropped: 'gone' });

    const next = changeSettingsFormat(versionOne, state, versionTwo);

    expect(readSettingsEditorState(versionTwo, next)).toEqual({
      ok: true,
      settings: { title: 'Morning', voice: 'calm', speed: 2, music: true },
    });
  });

  test('leaves a select empty when the new format does not offer its value', () => {
    const state = createSettingsEditorState(versionOne, { voice: 'bright' });

    expect(changeSettingsFormat(versionOne, state, versionTwo).inputValues.voice).toBe('');
  });

  test('keeps text that cannot be read yet in a field of the same kind', () => {
    const state = createSettingsEditorState(versionOne, {});

    const next = changeSettingsFormat(versionOne, { ...state, inputValues: { ...state.inputValues, length: '1x' } }, versionTwo);

    expect(next.inputValues.length).toBe('1x');
  });

  test('keeps JSON being written as it is', () => {
    const state = { ...createSettingsEditorState(versionOne, {}), isEditingJSON: true, settingsJSON: '{"title": ' };

    expect(changeSettingsFormat(versionOne, state, versionTwo)).toEqual(state);
  });

  test('a format without fields gets the settings as JSON', () => {
    const state = createSettingsEditorState(versionOne, { title: 'Morning' });

    const next = changeSettingsFormat(versionOne, state, undefined);

    expect(readSettingsEditorState(undefined, next)).toEqual({ ok: true, settings: { title: 'Morning' } });
  });

  test('a value the other format does not have comes back with a format that has it', () => {
    const state = createSettingsEditorState(versionTwo, { title: 'Morning', music: false });

    const inVersionOne = changeSettingsFormat(versionTwo, state, versionOne);
    expect(readSettingsEditorState(versionOne, inVersionOne)).toEqual({ ok: true, settings: { title: 'Morning' } });

    const backInVersionTwo = changeSettingsFormat(versionOne, inVersionOne, versionTwo);
    expect(readSettingsEditorState(versionTwo, backInVersionTwo)).toEqual({
      ok: true,
      settings: { title: 'Morning', music: false },
    });
  });

  test('a field emptied before the change does not come back', () => {
    const state = createSettingsEditorState(versionOne, { title: 'Morning', dropped: 'gone' });
    const restored = changeSettingsFormat(versionTwo, changeSettingsFormat(versionOne, state, versionTwo), versionOne);
    expect(restored.inputValues.dropped).toBe('gone');

    const emptied = { ...restored, inputValues: { ...restored.inputValues, dropped: '' } };
    const next = changeSettingsFormat(versionTwo, changeSettingsFormat(versionOne, emptied, versionTwo), versionOne);

    expect(next.inputValues.dropped).toBe('');
  });

  test('Simple mode fills a field the JSON leaves out from a format left earlier', () => {
    const state = createSettingsEditorState(versionTwo, { title: 'Morning', music: true });
    const editing = startEditingSettingsJSON(versionOne, changeSettingsFormat(versionTwo, state, versionOne));
    if (!editing.ok) throw new Error(editing.error);
    expect(JSON.parse(editing.state.settingsJSON)).toEqual({ title: 'Morning' });
    const backInVersionTwo = changeSettingsFormat(versionOne, editing.state, versionTwo);

    const stopped = stopEditingSettingsJSON(versionTwo, backInVersionTwo);
    if (!stopped.ok) throw new Error(stopped.error);
    expect(readSettingsEditorState(versionTwo, stopped.state)).toEqual({
      ok: true,
      settings: { title: 'Morning', music: true },
    });

    // What the JSON says wins
    const written = stopEditingSettingsJSON(versionTwo, { ...backInVersionTwo, settingsJSON: '{"title": "Morning", "music": false}' });
    if (!written.ok) throw new Error(written.error);
    expect(readSettingsEditorState(versionTwo, written.state)).toEqual({
      ok: true,
      settings: { title: 'Morning', music: false },
    });
  });
});
