import { describe, test, expect } from 'vitest';
import type { SchedulerFormField } from '@audio-underview/supabase-connector';
import { createAnswerValues, readAnswer, readAnswerField } from './answer-form.ts';

function createField(overrides: Partial<SchedulerFormField> & Pick<SchedulerFormField, 'widget'>): SchedulerFormField {
  return { name: 'field', required: false, ...overrides };
}

const CHOICES = [{ label: 'One' }, { label: 'Two' }, { label: 'Three' }];

describe('createAnswerValues', () => {
  test('starts every widget empty without defaults', () => {
    const values = createAnswerValues([
      createField({ name: 'a', widget: 'checkboxes', choices: CHOICES }),
      createField({ name: 'b', widget: 'radio', choices: CHOICES }),
      createField({ name: 'c', widget: 'select', choices: CHOICES }),
      createField({ name: 'd', widget: 'text' }),
      createField({ name: 'e', widget: 'textarea' }),
      createField({ name: 'f', widget: 'number' }),
      createField({ name: 'g', widget: 'toggle' }),
    ]);

    expect(Object.fromEntries(values)).toEqual({ a: [], b: '', c: '', d: '', e: '', f: '', g: false });
  });

  test('starts from the defaults, choices by their index', () => {
    const values = createAnswerValues([
      createField({ name: 'a', widget: 'checkboxes', choices: CHOICES, default: [2, 0] }),
      createField({ name: 'b', widget: 'radio', choices: CHOICES, default: 1 }),
      createField({ name: 'c', widget: 'select', choices: CHOICES, default: 2 }),
      createField({ name: 'd', widget: 'text', default: 'hello' }),
      createField({ name: 'e', widget: 'textarea', default: 'long hello' }),
      createField({ name: 'f', widget: 'number', default: 2.5 }),
      createField({ name: 'g', widget: 'toggle', default: true }),
    ]);

    expect(Object.fromEntries(values)).toEqual({
      a: [2, 0],
      b: '1',
      c: '2',
      d: 'hello',
      e: 'long hello',
      f: '2.5',
      g: true,
    });
  });

  test('ignores a default that names no choice or the wrong type', () => {
    const values = createAnswerValues([
      createField({ name: 'a', widget: 'checkboxes', choices: CHOICES, default: [0, 0, 7, -1, 1.5, 'x'] }),
      createField({ name: 'b', widget: 'radio', choices: CHOICES, default: 3 }),
      createField({ name: 'c', widget: 'text', default: 4 }),
      createField({ name: 'd', widget: 'number', default: '4' }),
      createField({ name: 'e', widget: 'toggle', default: 'yes' }),
    ]);

    expect(Object.fromEntries(values)).toEqual({ a: [0], b: '', c: '', d: '', e: false });
  });
});

describe('readAnswerField', () => {
  test('answers the chosen checkboxes by index, in order', () => {
    const field = createField({ widget: 'checkboxes', choices: CHOICES });

    expect(readAnswerField(field, [2, 0])).toEqual({ answer: [0, 2], isMissing: false });
  });

  test('leaves out a field with nothing chosen, and says it is missing when it is required', () => {
    const choices = { widget: 'checkboxes', choices: CHOICES } as const;

    expect(readAnswerField(createField(choices), [])).toEqual({ answer: undefined, isMissing: false });
    expect(readAnswerField(createField({ ...choices, required: true }), [])).toEqual({ answer: undefined, isMissing: true });
    expect(readAnswerField(createField({ widget: 'radio', choices: CHOICES, required: true }), '')).toEqual({
      answer: undefined,
      isMissing: true,
    });
  });

  test('refuses fewer checkboxes than minItems and more than maxItems', () => {
    const field = createField({ widget: 'checkboxes', choices: CHOICES, minItems: 2, maxItems: 2 });

    expect(readAnswerField(field, [1]).problem).toBe('Choose at least 2.');
    expect(readAnswerField(field, [0, 1, 2]).problem).toBe('Choose at most 2.');
    expect(readAnswerField(field, [0, 1])).toEqual({ answer: [0, 1], isMissing: false });
  });

  test('answers a radio or a select by the index of the choice', () => {
    expect(readAnswerField(createField({ widget: 'radio', choices: CHOICES }), '2')).toEqual({ answer: 2, isMissing: false });
    expect(readAnswerField(createField({ widget: 'select', choices: CHOICES }), '0')).toEqual({ answer: 0, isMissing: false });
  });

  test('answers a toggle that is off as false', () => {
    expect(readAnswerField(createField({ widget: 'toggle' }), false)).toEqual({ answer: false, isMissing: false });
    expect(readAnswerField(createField({ widget: 'toggle' }), true)).toEqual({ answer: true, isMissing: false });
  });

  test('answers a number as a number and refuses one outside minimum and maximum', () => {
    const field = createField({ widget: 'number', minimum: 1, maximum: 10 });

    expect(readAnswerField(field, ' 2.5 ')).toEqual({ answer: 2.5, isMissing: false });
    expect(readAnswerField(field, '0').problem).toBe('Enter 1 or more.');
    expect(readAnswerField(field, '11').problem).toBe('Enter 10 or less.');
    expect(readAnswerField(field, 'abc').problem).toBe('Enter a number.');
    expect(readAnswerField(field, '')).toEqual({ answer: undefined, isMissing: false });
    expect(readAnswerField({ ...field, required: true }, '')).toEqual({ answer: undefined, isMissing: true });
  });

  test('refuses a fraction for a number whose schema is of type integer, and takes it for type number', () => {
    const field = createField({ widget: 'number', minimum: 1 });

    expect(readAnswerField(field, '2.5', { type: 'integer' }).problem).toBe('Enter a whole number.');
    expect(readAnswerField(field, ' 3 ', { type: 'integer' })).toEqual({ answer: 3, isMissing: false });
    expect(readAnswerField(field, '3.0', { type: 'integer' })).toEqual({ answer: 3, isMissing: false });
    expect(readAnswerField(field, '0.5', { type: 'integer' }).problem).toBe('Enter a whole number.');
    expect(readAnswerField(field, '2.5', { type: 'number' })).toEqual({ answer: 2.5, isMissing: false });
    expect(readAnswerField(field, '2.5')).toEqual({ answer: 2.5, isMissing: false });
  });

  test('answers text as typed, and counts text of spaces as empty', () => {
    const field = createField({ widget: 'text', required: true });

    expect(readAnswerField(field, ' https://example.com ')).toEqual({ answer: ' https://example.com ', isMissing: false });
    expect(readAnswerField(field, '   ')).toEqual({ answer: undefined, isMissing: true });
    expect(readAnswerField(createField({ widget: 'textarea' }), '')).toEqual({ answer: undefined, isMissing: false });
  });

  test('refuses text longer than maxLength', () => {
    const field = createField({ widget: 'textarea', maxLength: 5 });

    expect(readAnswerField(field, '12345')).toEqual({ answer: '12345', isMissing: false });
    expect(readAnswerField(field, '123456').problem).toBe('Use 5 characters or fewer.');
  });
});

describe('readAnswer', () => {
  const fields = [
    createField({ name: 'articles', widget: 'checkboxes', choices: CHOICES, required: true, minItems: 1 }),
    createField({ name: 'note', widget: 'text' }),
    createField({ name: 'loud', widget: 'toggle' }),
  ];

  test('collects the answers by the names of the fields and leaves out empty ones', () => {
    const values = createAnswerValues(fields).set('articles', [1]);

    expect(readAnswer(fields, values)).toEqual({
      answer: { articles: [1], loud: false },
      isComplete: true,
      problems: new Map(),
    });
  });

  test('is incomplete while a required field is empty', () => {
    const reading = readAnswer(fields, createAnswerValues(fields));

    expect(reading.isComplete).toBe(false);
    expect(reading.problems.size).toBe(0);
  });

  test('is incomplete with the problem of the field that cannot be sent', () => {
    const limited = [createField({ name: 'count', widget: 'number', maximum: 3 })];
    const reading = readAnswer(limited, createAnswerValues(limited).set('count', '9'));

    expect(reading.isComplete).toBe(false);
    expect(reading.problems.get('count')).toBe('Enter 3 or less.');
    expect(reading.answer).toEqual({});
  });

  test('checks a number against the type the schema of the form gives the field', () => {
    const counted = [createField({ name: 'count', widget: 'number' }), createField({ name: 'ratio', widget: 'number' })];
    const schema = { type: 'object', properties: { count: { type: 'integer' }, ratio: { type: 'number' } } };
    const values = createAnswerValues(counted).set('count', '1.5').set('ratio', '1.5');

    const reading = readAnswer(counted, values, schema);

    expect(reading.isComplete).toBe(false);
    expect(reading.problems).toEqual(new Map([['count', 'Enter a whole number.']]));
    expect(reading.answer).toEqual({ ratio: 1.5 });
    expect(readAnswer(counted, values.set('count', '2'), schema)).toEqual({
      answer: { count: 2, ratio: 1.5 },
      isComplete: true,
      problems: new Map(),
    });
  });

  test('reads only the own fields of the schema, not those an object inherits', () => {
    const named = [createField({ name: 'constructor', widget: 'number' })];
    const values = createAnswerValues(named).set('constructor', '1.5');

    expect(readAnswer(named, values, { type: 'object', properties: {} }).answer).toEqual({ constructor: 1.5 });
  });

  test('keeps a field named like an object key as an own key', () => {
    const named = [createField({ name: '__proto__', widget: 'text' })];
    const reading = readAnswer(named, createAnswerValues(named).set('__proto__', 'x'));

    expect(Object.keys(reading.answer)).toEqual(['__proto__']);
    expect(JSON.stringify(reading.answer)).toBe('{"__proto__":"x"}');
  });
});
