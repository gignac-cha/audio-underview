import type { CrawlerRow } from '@audio-underview/supabase-connector';
import { DEFAULT_CODE } from '../components/crawlers/CodeEditorPanel.tsx';
import {
  MAXIMUM_ENVIRONMENT_VARIABLES,
  validateEnvironmentVariableName,
} from '../schemas/environment-variable-rules.ts';

export interface FormState {
  name: string;
  url_pattern: string;
  code: string;
  input_schema: string;
  output_schema: string;
  // The names of the account's environment variables that the crawler reads
  environment_variable_names: string[];
}

export interface SchemaErrors {
  input_schema?: string;
  output_schema?: string;
}

export type SchemaField = 'input_schema' | 'output_schema';

export const BLANK_FORM: FormState = {
  name: '',
  url_pattern: '',
  code: DEFAULT_CODE,
  input_schema: '{}',
  output_schema: '{}',
  environment_variable_names: [],
};

export function stringifySchema(schema: Record<string, unknown>) {
  return JSON.stringify(schema, null, 2);
}

function readEnvironmentVariableNames(crawler: CrawlerRow): string[] {
  const names: unknown = crawler.environment_variable_names;
  // A crawler manager deployed before the declaration existed answers rows without it
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
}

export function deriveFormState(crawler: CrawlerRow): FormState {
  return {
    name: crawler.name,
    url_pattern: crawler.url_pattern ?? '',
    code: crawler.code,
    input_schema: stringifySchema(crawler.input_schema ?? {}),
    output_schema: stringifySchema(crawler.output_schema ?? {}),
    environment_variable_names: readEnvironmentVariableNames(crawler),
  };
}

export function tryParseSchema(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function computeIsDirty(form: FormState | undefined, pristine: FormState | undefined): boolean {
  if (!form || !pristine) return false;
  return (
    form.name !== pristine.name ||
    form.url_pattern !== pristine.url_pattern ||
    form.code !== pristine.code ||
    form.input_schema !== pristine.input_schema ||
    form.output_schema !== pristine.output_schema ||
    !haveSameNames(form.environment_variable_names, pristine.environment_variable_names)
  );
}

function haveSameNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Checks a name to declare against the rules of the crawler manager and the names already declared.
 */
export function validateDeclaredEnvironmentVariableName(name: string, declaredNames: string[]): string | undefined {
  const nameError = validateEnvironmentVariableName(name);
  if (nameError) return nameError;
  if (declaredNames.includes(name)) return `${name} is already declared.`;
  if (declaredNames.length >= MAXIMUM_ENVIRONMENT_VARIABLES) {
    return `A crawler can declare at most ${MAXIMUM_ENVIRONMENT_VARIABLES} names.`;
  }
  return undefined;
}
