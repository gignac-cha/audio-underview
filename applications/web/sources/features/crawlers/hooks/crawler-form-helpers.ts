import { plainObjectSchema, type Crawler, type PlainObject } from '@audio-underview/schemas';

/** 에디터 폼 상태 — 스키마 2필드는 편집 편의를 위해 JSON 텍스트로 보관한다. */
export interface FormState {
  name: string;
  url_pattern: string;
  code: string;
  input_schema: string;
  output_schema: string;
}

export type SchemaField = 'input_schema' | 'output_schema';

export const BLANK_FORM: FormState = {
  name: '',
  url_pattern: '',
  code: '',
  input_schema: '{}',
  output_schema: '{}',
};

const formatSchema = (value: PlainObject): string => JSON.stringify(value, null, 2);

/** 서버 crawler → 폼 상태. */
export const deriveFormState = (crawler: Crawler): FormState => ({
  name: crawler.name,
  url_pattern: crawler.url_pattern ?? '',
  code: crawler.code,
  input_schema: formatSchema(crawler.input_schema),
  output_schema: formatSchema(crawler.output_schema),
});

export type SchemaParseResult =
  | { ok: true; value: PlainObject }
  | { ok: false };

/** JSON **object**만 허용 (배열/원시 불가). */
export const tryParseSchema = (text: string): SchemaParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const result = plainObjectSchema.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false };
};

export const formsAreEqual = (a: FormState, b: FormState): boolean =>
  a.name === b.name &&
  a.url_pattern === b.url_pattern &&
  a.code === b.code &&
  a.input_schema === b.input_schema &&
  a.output_schema === b.output_schema;

export const computeIsDirty = (form: FormState, pristine: FormState): boolean =>
  !formsAreEqual(form, pristine);
