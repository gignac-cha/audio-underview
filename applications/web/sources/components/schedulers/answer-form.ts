import type { SchedulerFormField } from '@audio-underview/supabase-connector';

/**
 * What a field holds while it is filled in: the indexes of the checked choices, a toggle's state,
 * or text: what was typed, or for a radio or a select the index of the choice (empty when none is chosen).
 */
export type AnswerFieldValue = string | boolean | number[];

/** The values by the names of the fields, which a Map keeps whatever the names are */
export type AnswerValues = Map<string, AnswerFieldValue>;

/** What one field answers. The answer is left out (undefined) when the field was left empty. */
export interface AnswerFieldReading {
  answer: unknown;
  // A required field that is empty
  isMissing: boolean;
  // Why a filled field cannot be sent
  problem?: string;
}

export interface AnswerReading {
  // The answer to send; fields left empty are left out
  answer: Record<string, unknown>;
  // False while a required field is empty or a field has a problem
  isComplete: boolean;
  problems: Map<string, string>;
}

function initialValue(field: SchedulerFormField): AnswerFieldValue {
  const choiceCount = field.choices?.length ?? 0;
  const isChoiceIndex = (candidate: unknown): candidate is number => {
    return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0 && candidate < choiceCount;
  };

  switch (field.widget) {
    case 'checkboxes':
      return Array.isArray(field.default) ? [...new Set(field.default.filter(isChoiceIndex))] : [];
    case 'radio':
    case 'select':
      return isChoiceIndex(field.default) ? String(field.default) : '';
    case 'toggle':
      return field.default === true;
    case 'number':
      return typeof field.default === 'number' ? String(field.default) : '';
    case 'text':
    case 'textarea':
      return typeof field.default === 'string' ? field.default : '';
  }
}

/**
 * The values a form starts with: the default of each field, or nothing chosen or typed.
 */
export function createAnswerValues(fields: SchedulerFormField[]): AnswerValues {
  return new Map(fields.map((field) => [field.name, initialValue(field)]));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The schema the form gives a field in its JSON Schema, which says what the field list does not:
 * whether a number must be whole.
 */
function fieldSchemaOf(schema: Record<string, unknown> | undefined, name: string): Record<string, unknown> | undefined {
  const properties = schema?.properties;
  if (!isPlainObject(properties) || !Object.hasOwn(properties, name)) {
    return undefined;
  }
  const fieldSchema = properties[name];
  return isPlainObject(fieldSchema) ? fieldSchema : undefined;
}

/**
 * What one field answers, a choice by its index as the server reads it. Only what the form says is
 * checked; the server checks the answer again and says why when it refuses it.
 *
 * @param fieldSchema - the schema of the field in the form's JSON Schema, when there is one
 */
export function readAnswerField(
  field: SchedulerFormField,
  value: AnswerFieldValue | undefined,
  fieldSchema?: Record<string, unknown>,
): AnswerFieldReading {
  switch (field.widget) {
    case 'checkboxes': {
      const selected = Array.isArray(value) ? [...value].sort((left, right) => left - right) : [];
      if (selected.length === 0) {
        return { answer: undefined, isMissing: field.required };
      }
      if (field.minItems !== undefined && selected.length < field.minItems) {
        return { answer: undefined, isMissing: false, problem: `Choose at least ${field.minItems}.` };
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        return { answer: undefined, isMissing: false, problem: `Choose at most ${field.maxItems}.` };
      }
      return { answer: selected, isMissing: false };
    }
    case 'radio':
    case 'select': {
      const text = typeof value === 'string' ? value : '';
      return text === ''
        ? { answer: undefined, isMissing: field.required }
        : { answer: Number(text), isMissing: false };
    }
    case 'toggle':
      return { answer: value === true, isMissing: false };
    case 'number': {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') {
        return { answer: undefined, isMissing: field.required };
      }
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return { answer: undefined, isMissing: false, problem: 'Enter a number.' };
      }
      // The server refuses a fraction for a field of type integer
      if (fieldSchema?.type === 'integer' && !Number.isInteger(parsed)) {
        return { answer: undefined, isMissing: false, problem: 'Enter a whole number.' };
      }
      if (field.minimum !== undefined && parsed < field.minimum) {
        return { answer: undefined, isMissing: false, problem: `Enter ${field.minimum} or more.` };
      }
      if (field.maximum !== undefined && parsed > field.maximum) {
        return { answer: undefined, isMissing: false, problem: `Enter ${field.maximum} or less.` };
      }
      return { answer: parsed, isMissing: false };
    }
    case 'text':
    case 'textarea': {
      const text = typeof value === 'string' ? value : '';
      if (text.trim() === '') {
        return { answer: undefined, isMissing: field.required };
      }
      if (field.maxLength !== undefined && text.length > field.maxLength) {
        return { answer: undefined, isMissing: false, problem: `Use ${field.maxLength} characters or fewer.` };
      }
      return { answer: text, isMissing: false };
    }
  }
}

/**
 * @param schema - the JSON Schema of the form, which the server checks the answer against
 */
export function readAnswer(
  fields: SchedulerFormField[],
  values: AnswerValues,
  schema?: Record<string, unknown>,
): AnswerReading {
  const entries: [string, unknown][] = [];
  const problems: Map<string, string> = new Map();
  let isComplete = true;

  for (const field of fields) {
    const reading = readAnswerField(field, values.get(field.name), fieldSchemaOf(schema, field.name));
    if (reading.isMissing) {
      isComplete = false;
    }
    if (reading.problem !== undefined) {
      isComplete = false;
      problems.set(field.name, reading.problem);
    }
    if (reading.answer !== undefined) {
      entries.push([field.name, reading.answer]);
    }
  }

  return { answer: Object.fromEntries(entries), isComplete, problems };
}
