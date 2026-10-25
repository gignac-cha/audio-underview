import { describe, it, expect } from 'vitest';
import type { SchedulerStageRunForm } from '@audio-underview/supabase-connector';
import { type FormDefinition, checkFormStageSettings } from '../sources/form-definition.ts';
import { findRepeatedChoice, mapAnswer, resolveForm } from '../sources/form-resolution.ts';

// The three forms of the newscast templates
const ARTICLES_FORM = {
  type: 'object',
  properties: {
    articles: {
      type: 'array',
      title: 'Articles',
      'x-widget': 'checkboxes',
      'x-options': { from: '$', label: 'title', description: 'originalUrl' },
      minItems: 1,
      maxItems: 10,
    },
  },
  required: ['articles'],
};

const URL_FORM = {
  type: 'object',
  properties: {
    url: { type: 'string', title: 'URL', 'x-widget': 'text', format: 'uri', maxLength: 2048 },
  },
  required: ['url'],
};

const TEXT_FORM = {
  type: 'object',
  properties: {
    title: { type: 'string', 'x-widget': 'text', 'x-order': 0, maxLength: 200 },
    text: { type: 'string', 'x-widget': 'textarea', 'x-order': 1, maxLength: 24000 },
  },
  required: ['text'],
};

// The keys of each object ordered as Postgres keeps them in JSONB: shorter first, then by bytes
function asJSONB(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asJSONB);
  if (typeof value !== 'object' || value === null) return value;
  const keys = Object.keys(value).sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(keys.map((key) => [key, asJSONB((value as Record<string, unknown>)[key])]));
}

const ARTICLES = [
  { title: 'First', discussionUrl: 'https://news.hada.io/topic?id=1', originalUrl: 'https://a.example.com/1' },
  { title: 'Second', discussionUrl: 'https://news.hada.io/topic?id=2', originalUrl: 'https://a.example.com/2' },
  { title: 'Third', discussionUrl: '', originalUrl: 'https://a.example.com/3' },
];

function formWith(field: Record<string, unknown>, name = 'field'): Record<string, unknown> {
  return { type: 'object', properties: { [name]: field } };
}

function definitionOf(form: Record<string, unknown>): FormDefinition {
  const check = checkFormStageSettings({ form });
  if (!check.valid) throw new Error(check.description);
  return check.settings.form;
}

function resolvedFormOf(form: Record<string, unknown>, input: unknown) {
  const resolution = resolveForm(definitionOf(form), input);
  if (!resolution.resolved) throw new Error(`No choices for ${resolution.fieldName}`);
  return resolution.form;
}

// The form as a stage run stores it
function storedFormOf(form: Record<string, unknown>, input: unknown): SchedulerStageRunForm {
  const { schema, fields } = resolvedFormOf(form, input);
  return { schema, fields, expires_at: '2026-10-26T01:00:00.000Z' };
}

describe('checkFormStageSettings', () => {
  it.each([
    ['the GeekNews articles', ARTICLES_FORM],
    ['a URL', URL_FORM],
    ['a pasted text', TEXT_FORM],
    ['a radio with an enum', formWith({ 'x-widget': 'radio', enum: ['a', 'b'] })],
    ['a select with x-options of nested paths', formWith({ 'x-widget': 'select', 'x-options': { from: '$.data.items', label: 'meta.name', value: 'id' } })],
    ['a select whose type describes the values', formWith({ type: 'string', 'x-widget': 'select', 'x-options': { from: '$', label: '$' } })],
    ['checkboxes with items.enum', formWith({ type: 'array', 'x-widget': 'checkboxes', items: { type: 'string', enum: ['a', 'b'] } })],
    ['checkboxes with x-options and items without enum', formWith({ type: 'array', 'x-widget': 'checkboxes', items: { type: 'object' }, 'x-options': { from: '$', label: 'title' } })],
    ['a number of type integer', formWith({ type: 'integer', 'x-widget': 'number', minimum: 1, maximum: 10 })],
    ['a number of type number', formWith({ type: 'number', 'x-widget': 'number' })],
    ['a toggle', formWith({ type: 'boolean', 'x-widget': 'toggle', default: false })],
    ['a title and a description at the top', { ...URL_FORM, title: 'Pick', description: 'One URL' }],
    ['x-order 0 on a field', formWith({ type: 'string', 'x-widget': 'text', 'x-order': 0 })],
    ['the same x-order on two fields', { type: 'object', properties: { a: { type: 'string', 'x-widget': 'text', 'x-order': 3 }, b: { type: 'boolean', 'x-widget': 'toggle', 'x-order': 3 } } }],
  ])('accepts %s', (_, form) => {
    expect(checkFormStageSettings({ form })).toEqual({ valid: true, settings: { form, timeoutMinutes: 1440 } });
  });

  it.each([1, 30, 525600])('takes timeout_minutes %s', (timeoutMinutes) => {
    expect(checkFormStageSettings({ form: URL_FORM, timeout_minutes: timeoutMinutes })).toEqual({
      valid: true,
      settings: { form: URL_FORM, timeoutMinutes },
    });
  });

  it.each([
    ['settings that are not an object', [], "Field 'settings' must be a JSON object"],
    ['a key besides form and timeout_minutes', { form: URL_FORM, schema: {} }, "Field 'settings.schema' is not allowed on a form stage"],
    ['no form', {}, "Field 'settings.form' is required and must be a JSON object"],
    ['a form that is an array', { form: [] }, "Field 'settings.form' is required and must be a JSON object"],
    ['timeout_minutes of 0', { form: URL_FORM, timeout_minutes: 0 }, "Field 'settings.timeout_minutes' must be an integer from 1 to 525600"],
    ['timeout_minutes above a year', { form: URL_FORM, timeout_minutes: 525601 }, "Field 'settings.timeout_minutes' must be an integer from 1 to 525600"],
    ['a fractional timeout_minutes', { form: URL_FORM, timeout_minutes: 1.5 }, "Field 'settings.timeout_minutes' must be an integer from 1 to 525600"],
    ['timeout_minutes as a string', { form: URL_FORM, timeout_minutes: '30' }, "Field 'settings.timeout_minutes' must be an integer from 1 to 525600"],
  ])('rejects %s', (_, settings, description) => {
    expect(checkFormStageSettings(settings)).toEqual({ valid: false, description });
  });

  it.each([
    ['a keyword the scheduler cannot read', formWith({ type: 'string', 'x-widget': 'text', pattern: 'x' }), "Schema keyword 'pattern' at $.properties.field is not supported"],
    ['a format other than uri', formWith({ type: 'string', 'x-widget': 'text', format: 'email' }), "Schema keyword 'format' at $.properties.field has an unsupported value"],
    ['a top that is not an object', { type: 'array', properties: { a: { type: 'string', 'x-widget': 'text' } } }, "$ must have type 'object'"],
    ['a top without a type', { properties: { a: { type: 'string', 'x-widget': 'text' } } }, "$ must have type 'object'"],
    ['no field', { type: 'object', properties: {} }, '$.properties must have at least one field'],
    ['no properties', { type: 'object' }, '$.properties must have at least one field'],
    ['additionalProperties at the top', { ...URL_FORM, additionalProperties: true }, "$ must not have 'additionalProperties'"],
    ['an x- key at the top', { ...URL_FORM, 'x-widget': 'text' }, "$ must not have 'x-widget'"],
    ['a required name that is not a field', { ...URL_FORM, required: ['link'] }, "$.required names 'link', which is not a field"],
    ['a field without x-widget', formWith({ type: 'string' }), '$.properties.field must have x-widget, one of: checkboxes, radio, select, text, textarea, number, toggle'],
    ['an unknown widget', formWith({ type: 'string', 'x-widget': 'slider' }), '$.properties.field must have x-widget, one of: checkboxes, radio, select, text, textarea, number, toggle'],
    ['an unknown x- key on a field', formWith({ type: 'string', 'x-widget': 'text', 'x-hidden': true }), "$.properties.field must not have 'x-hidden'"],
    ['a negative x-order', formWith({ type: 'string', 'x-widget': 'text', 'x-order': -1 }), '$.properties.field["x-order"] must be a non-negative integer'],
    ['a fractional x-order', formWith({ type: 'string', 'x-widget': 'text', 'x-order': 1.5 }), '$.properties.field["x-order"] must be a non-negative integer'],
    ['an x-order as a string', formWith({ type: 'string', 'x-widget': 'text', 'x-order': '1' }), '$.properties.field["x-order"] must be a non-negative integer'],
    ['an x-order in items', formWith({ type: 'array', 'x-widget': 'checkboxes', items: { enum: ['a'], 'x-order': 0 } }), "$.properties.field.items must not have 'x-order': only the fields of a form take x-widget, x-options and x-order"],
    ['checkboxes of type string', formWith({ type: 'string', 'x-widget': 'checkboxes', 'x-options': { from: '$', label: 'title' } }), "$.properties.field must have type 'array' for x-widget 'checkboxes'"],
    ['checkboxes without choices', formWith({ type: 'array', 'x-widget': 'checkboxes', items: { type: 'string' } }), "$.properties.field must take its choices from x-options or items.enum for x-widget 'checkboxes'"],
    [
      'checkboxes with both kinds of choices',
      formWith({ type: 'array', 'x-widget': 'checkboxes', items: { enum: ['a'] }, 'x-options': { from: '$', label: 'title' } }),
      '$.properties.field must take its choices from x-options or items.enum, not both',
    ],
    ['a radio without choices', formWith({ type: 'string', 'x-widget': 'radio' }), "$.properties.field must take its choices from x-options or enum for x-widget 'radio'"],
    ['a select with both kinds of choices', formWith({ 'x-widget': 'select', enum: ['a'], 'x-options': { from: '$', label: '$' } }), '$.properties.field must take its choices from x-options or enum, not both'],
    ['a text of type number', formWith({ type: 'number', 'x-widget': 'text' }), "$.properties.field must have type 'string' for x-widget 'text'"],
    ['a textarea of a type list', formWith({ type: ['string', 'null'], 'x-widget': 'textarea' }), "$.properties.field must have type 'string' for x-widget 'textarea'"],
    ['a textarea with format', formWith({ type: 'string', 'x-widget': 'textarea', format: 'uri' }), "$.properties.field must not have format: only x-widget 'text' takes format 'uri'"],
    ['a number of type string', formWith({ type: 'string', 'x-widget': 'number' }), "$.properties.field must have type 'number' or 'integer' for x-widget 'number'"],
    ['a toggle of type string', formWith({ type: 'string', 'x-widget': 'toggle' }), "$.properties.field must have type 'boolean' for x-widget 'toggle'"],
    ['x-options on a text', formWith({ type: 'string', 'x-widget': 'text', 'x-options': { from: '$', label: '$' } }), '$.properties.field must not have x-options: only checkboxes, radio and select take choices'],
    ['x-options that is not an object', formWith({ 'x-widget': 'radio', 'x-options': '$' }), '$.properties.field["x-options"] must be a JSON object'],
    ['x-options with an unknown key', formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: '$', sort: 'title' } }), `$.properties.field["x-options"] must not have 'sort'`],
    ['x-options without from', formWith({ 'x-widget': 'radio', 'x-options': { label: '$' } }), `$.properties.field["x-options"].from must be '$' or a path that starts with '$.'`],
    ['a from path without $', formWith({ 'x-widget': 'radio', 'x-options': { from: 'items', label: '$' } }), `$.properties.field["x-options"].from must be '$' or a path that starts with '$.'`],
    ['a from path with an empty part', formWith({ 'x-widget': 'radio', 'x-options': { from: '$..items', label: '$' } }), `$.properties.field["x-options"].from must be '$' or a path that starts with '$.'`],
    ['x-options without label', formWith({ 'x-widget': 'radio', 'x-options': { from: '$' } }), `$.properties.field["x-options"].label must be '$' or a path inside an item`],
    ['a label path that starts with $.', formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: '$.title' } }), `$.properties.field["x-options"].label must be '$' or a path inside an item`],
    ['a description path that is not a string', formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: 'title', description: 1 } }), `$.properties.field["x-options"].description must be '$' or a path inside an item`],
    ['an empty value path', formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: 'title', value: '' } }), `$.properties.field["x-options"].value must be '$' or a path inside an item`],
    ['an x- key in items', formWith({ type: 'array', 'x-widget': 'checkboxes', items: { enum: ['a'], 'x-widget': 'text' } }), "$.properties.field.items must not have 'x-widget': only the fields of a form take x-widget, x-options and x-order"],
    ['a field name that is not an identifier', formWith({ type: 'string' }, 'field name'), '$.properties["field name"] must have x-widget, one of: checkboxes, radio, select, text, textarea, number, toggle'],
  ])('rejects a form with %s', (_, form, reason) => {
    expect(checkFormStageSettings({ form })).toEqual({ valid: false, description: `Field 'settings.form' is not a valid form: ${reason}` });
  });
});

describe('resolveForm', () => {
  it('resolves the GeekNews articles to choices of their titles and URLs, numbered in the schema', () => {
    const form = resolvedFormOf(ARTICLES_FORM, ARTICLES);

    expect(form.schema).toEqual({
      type: 'object',
      properties: {
        articles: { title: 'Articles', type: 'array', items: { type: 'integer', enum: [0, 1, 2] }, minItems: 1, maxItems: 10 },
      },
      required: ['articles'],
      additionalProperties: false,
    });
    expect(form.fields).toEqual([{
      name: 'articles',
      title: 'Articles',
      widget: 'checkboxes',
      required: true,
      choices: [
        { label: 'First', description: 'https://a.example.com/1' },
        { label: 'Second', description: 'https://a.example.com/2' },
        { label: 'Third', description: 'https://a.example.com/3' },
      ],
      minItems: 1,
      maxItems: 10,
    }]);
    expect(form.choiceValues.get('articles')).toEqual(ARTICLES);
  });

  it('keeps the other fields as they are, without their x- keys', () => {
    expect(resolvedFormOf(URL_FORM, {}).schema).toEqual({
      type: 'object',
      properties: { url: { type: 'string', title: 'URL', format: 'uri', maxLength: 2048 } },
      required: ['url'],
      additionalProperties: false,
    });
    expect(resolvedFormOf(TEXT_FORM, {}).fields).toEqual([
      { name: 'title', widget: 'text', required: false, maxLength: 200 },
      { name: 'text', widget: 'textarea', required: true, maxLength: 24000 },
    ]);
  });

  it('shows the fields by x-order, whatever the order of the keys the database gives back', () => {
    const stored = asJSONB(TEXT_FORM) as Record<string, unknown>;
    expect(Object.keys(stored.properties as object)).toEqual(['text', 'title']);

    expect(resolvedFormOf(stored, {}).fields.map((field) => field.name)).toEqual(['title', 'text']);
    expect(Object.keys(resolvedFormOf(stored, {}).schema.properties as object)).toEqual(['title', 'text']);
  });

  it('shows the fields with the same x-order by name, and the fields without one after the others, by name', () => {
    const form = resolvedFormOf({
      type: 'object',
      properties: {
        zeta: { type: 'string', 'x-widget': 'text' },
        beta: { type: 'string', 'x-widget': 'text', 'x-order': 2 },
        alpha: { type: 'string', 'x-widget': 'text', 'x-order': 2 },
        last: { type: 'string', 'x-widget': 'text', 'x-order': 10 },
        first: { type: 'string', 'x-widget': 'text', 'x-order': 0 },
        Upper: { type: 'string', 'x-widget': 'text' },
        lower: { type: 'string', 'x-widget': 'text' },
      },
    }, {});

    // By code unit, so an upper case name comes before a lower case one
    expect(form.fields.map((field) => field.name)).toEqual(['first', 'alpha', 'beta', 'last', 'Upper', 'lower', 'zeta']);
  });

  it('leaves x-order out of the schema and the fields of the form', () => {
    const form = resolvedFormOf({ ...ARTICLES_FORM, properties: { articles: { ...ARTICLES_FORM.properties.articles, 'x-order': 0 } } }, ARTICLES);

    expect(JSON.stringify(form.schema)).not.toContain('x-order');
    expect(JSON.stringify(form.fields)).not.toContain('x-order');
    expect(JSON.stringify(resolvedFormOf(TEXT_FORM, {}))).not.toContain('x-order');
  });

  it('keeps the limits and the default of a number and a toggle', () => {
    const form = resolvedFormOf({
      type: 'object',
      properties: {
        count: { type: 'integer', 'x-widget': 'number', minimum: 1, maximum: 10, default: 3, description: 'How many' },
        signal: { type: 'boolean', 'x-widget': 'toggle', default: false },
      },
    }, {});

    expect(form.fields).toEqual([
      { name: 'count', description: 'How many', widget: 'number', required: false, minimum: 1, maximum: 10, default: 3 },
      { name: 'signal', widget: 'toggle', required: false, default: false },
    ]);
    expect(form.schema).not.toHaveProperty('required');
  });

  it('takes the choices from a path in the input, the labels and the values from paths in each item', () => {
    const form = resolvedFormOf(
      formWith({ 'x-widget': 'select', 'x-options': { from: '$.data.items', label: 'meta.name', value: 'id' } }, 'pick'),
      { data: { items: [{ id: 7, meta: { name: 'Seven' } }, { id: 8, meta: { name: 'Eight' } }, { meta: { name: 'No id' } }] } },
    );

    expect(form.schema.properties).toEqual({ pick: { type: 'integer', enum: [0, 1, 2] } });
    expect(form.fields[0]).toEqual({ name: 'pick', widget: 'select', required: false, choices: [{ label: 'Seven' }, { label: 'Eight' }, { label: 'No id' }] });
    // An item without the value stands for null
    expect(form.choiceValues.get('pick')).toEqual([7, 8, null]);
  });

  it('reads numbers of array items in a path', () => {
    const form = resolvedFormOf(
      formWith({ 'x-widget': 'radio', 'x-options': { from: '$.pages.1', label: 'names.0' } }),
      { pages: [[], [{ names: ['A', 'a'] }, { names: ['B'] }]] },
    );

    expect(form.fields[0].choices).toEqual([{ label: 'A' }, { label: 'B' }]);
  });

  it('writes a label that is not a string as text, and leaves out an empty description', () => {
    const form = resolvedFormOf(
      formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: 'name', description: 'note' } }),
      [{ name: 3, note: '' }, { name: true, note: null }, { name: { a: 1 } }, { note: 'only a note' }, 'not an object'],
    );

    expect(form.fields[0].choices).toEqual([
      { label: '3' },
      { label: 'true' },
      { label: '{"a":1}' },
      { label: '', description: 'only a note' },
      { label: '' },
    ]);
  });

  it("takes '$' for the item itself", () => {
    const form = resolvedFormOf(formWith({ 'x-widget': 'radio', 'x-options': { from: '$', label: '$' } }), ['a', 'b']);

    expect(form.fields[0].choices).toEqual([{ label: 'a' }, { label: 'b' }]);
    expect(form.choiceValues.get('field')).toEqual(['a', 'b']);
  });

  it('keeps the first 200 choices and cuts each label to 300 characters', () => {
    const items = Array.from({ length: 250 }, (_, index) => ({ title: `${index}:${'😀'.repeat(400)}`, url: `https://a.example.com/${index}` }));

    const form = resolvedFormOf(formWith({ type: 'array', 'x-widget': 'checkboxes', 'x-options': { from: '$', label: 'title' } }), items);

    const choices = form.fields[0].choices!;
    expect(choices).toHaveLength(200);
    expect([...choices[0].label]).toHaveLength(300);
    expect(choices[0].label.startsWith('0:😀')).toBe(true);
    expect(choices[199].label.startsWith('199:')).toBe(true);
    expect((form.schema.properties as Record<string, { items: { enum: number[] } }>).field.items.enum).toEqual(Array.from({ length: 200 }, (_, index) => index));
    expect(form.choiceValues.get('field')).toEqual(items.slice(0, 200));
  });

  it('takes the choices of an enum, with the default as the number of its choice', () => {
    const form = resolvedFormOf({
      type: 'object',
      properties: {
        length: { type: 'string', 'x-widget': 'radio', enum: ['short', 'standard', 'long'], default: 'standard' },
        topics: { type: 'array', 'x-widget': 'checkboxes', items: { type: 'string', enum: ['a', 'b', 'c'] }, default: ['c', 'a'] },
        mood: { 'x-widget': 'select', enum: [1, 2], default: 3 },
      },
    }, {});

    expect(form.schema.properties).toEqual({
      length: { type: 'integer', enum: [0, 1, 2], default: 1 },
      topics: { type: 'array', items: { type: 'integer', enum: [0, 1, 2] }, default: [2, 0] },
      // A default that is not a choice is left out
      mood: { type: 'integer', enum: [0, 1] },
    });
    // Without x-order the fields come by name
    expect(form.fields.map((field) => [field.name, field.choices, field.default])).toEqual([
      ['length', [{ label: 'short' }, { label: 'standard' }, { label: 'long' }], 1],
      ['mood', [{ label: '1' }, { label: '2' }], undefined],
      ['topics', [{ label: 'a' }, { label: 'b' }, { label: 'c' }], [2, 0]],
    ]);
    expect(form.choiceValues.get('length')).toEqual(['short', 'standard', 'long']);
  });

  it.each([
    ['the path leads to an object', { data: { items: {} } }],
    ['the array is empty', { data: { items: [] } }],
    ['the path leads nowhere', {}],
    ['the input is not an object', 'text'],
  ])('names the field without choices when %s', (_, input) => {
    const definition = definitionOf({
      type: 'object',
      properties: {
        note: { type: 'string', 'x-widget': 'text' },
        articles: { type: 'array', 'x-widget': 'checkboxes', 'x-options': { from: '$.data.items', label: 'title' } },
      },
    });

    expect(resolveForm(definition, input)).toEqual({ resolved: false, fieldName: 'articles' });
  });
});

describe('findRepeatedChoice', () => {
  const form = storedFormOf(ARTICLES_FORM, ARTICLES);

  it('names the second time a number is chosen', () => {
    expect(findRepeatedChoice(form, { articles: [2, 0, 2, 0] })).toEqual({ path: '$.articles[2]', reason: 'is chosen more than once' });
  });

  it('passes numbers chosen once, and fields that are not checkboxes', () => {
    expect(findRepeatedChoice(form, { articles: [2, 0, 1] })).toBeUndefined();
    expect(findRepeatedChoice(storedFormOf(URL_FORM, {}), { url: 'https://a.example.com' })).toBeUndefined();
  });
});

describe('mapAnswer', () => {
  it('maps the chosen numbers to the items they stand for, in the order chosen', () => {
    const definition = definitionOf(ARTICLES_FORM);

    expect(mapAnswer(definition, storedFormOf(ARTICLES_FORM, ARTICLES), ARTICLES, { articles: [2, 0] })).toEqual({
      mapped: true,
      output: { articles: [ARTICLES[2], ARTICLES[0]] },
    });
  });

  it('maps through the value path, and keeps the other fields as they are', () => {
    const form = {
      type: 'object',
      properties: {
        pick: { 'x-widget': 'radio', 'x-options': { from: '$.items', label: 'name', value: 'id' } },
        note: { type: 'string', 'x-widget': 'text' },
      },
    };
    const input = { items: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };

    expect(mapAnswer(definitionOf(form), storedFormOf(form, input), input, { pick: 1, note: 'hello' })).toEqual({
      mapped: true,
      output: { pick: 'b', note: 'hello' },
    });
  });

  it('maps the numbers of an enum to its values', () => {
    const form = formWith({ type: 'string', 'x-widget': 'select', enum: ['short', 'long'] }, 'length');

    expect(mapAnswer(definitionOf(form), storedFormOf(form, {}), {}, { length: 1 })).toEqual({ mapped: true, output: { length: 'long' } });
  });

  it('compares the choices whatever the order of the keys the database gives back', () => {
    const stored = storedFormOf(ARTICLES_FORM, ARTICLES);
    const reordered = JSON.parse(JSON.stringify({
      ...stored,
      fields: stored.fields.map((field) => ({ ...field, choices: field.choices!.map(({ label, description }) => ({ description, label })) })),
    })) as SchedulerStageRunForm;

    expect(mapAnswer(definitionOf(ARTICLES_FORM), reordered, ARTICLES, { articles: [1] })).toEqual({ mapped: true, output: { articles: [ARTICLES[1]] } });
  });

  it.each([
    ['the label path changed', { ...ARTICLES_FORM, properties: { articles: { ...ARTICLES_FORM.properties.articles, 'x-options': { from: '$', label: 'originalUrl' } } } }],
    ['the field became a text', { type: 'object', properties: { articles: { type: 'string', 'x-widget': 'text' } } }],
    ['the field was renamed', { type: 'object', properties: { picks: ARTICLES_FORM.properties.articles } }],
    ['the from path leads nowhere now', { ...ARTICLES_FORM, properties: { articles: { ...ARTICLES_FORM.properties.articles, 'x-options': { from: '$.list', label: 'title' } } } }],
    [
      'a choice field was added',
      { ...ARTICLES_FORM, properties: { ...ARTICLES_FORM.properties, again: ARTICLES_FORM.properties.articles } },
    ],
  ])('does not map the answer when %s since the form was shown', (_, editedForm) => {
    expect(mapAnswer(definitionOf(editedForm), storedFormOf(ARTICLES_FORM, ARTICLES), ARTICLES, { articles: [0] })).toEqual({ mapped: false });
  });

  it('still maps when only a field without choices changed', () => {
    const form = { ...ARTICLES_FORM, properties: { ...ARTICLES_FORM.properties, note: { type: 'string', 'x-widget': 'text' } } };
    const editedForm = { ...form, properties: { ...form.properties, note: { type: 'string', 'x-widget': 'textarea', maxLength: 5 } } };

    expect(mapAnswer(definitionOf(editedForm), storedFormOf(form, ARTICLES), ARTICLES, { articles: [0], note: 'n' })).toEqual({
      mapped: true,
      output: { articles: [ARTICLES[0]], note: 'n' },
    });
  });
});
