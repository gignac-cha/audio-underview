import type { CrawlerRow } from '@audio-underview/supabase-connector';
import { DEFAULT_CODE } from '../components/crawlers/CodeEditorPanel.tsx';

export interface FormState {
  name: string;
  url_pattern: string;
  code: string;
  input_schema: string;
  output_schema: string;
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
};

export function stringifySchema(schema: Record<string, unknown>) {
  return JSON.stringify(schema, null, 2);
}

export function deriveFormState(crawler: CrawlerRow): FormState {
  return {
    name: crawler.name,
    url_pattern: crawler.url_pattern ?? '',
    code: crawler.code,
    input_schema: stringifySchema(crawler.input_schema ?? {}),
    output_schema: stringifySchema(crawler.output_schema ?? {}),
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
    form.output_schema !== pristine.output_schema
  );
}
