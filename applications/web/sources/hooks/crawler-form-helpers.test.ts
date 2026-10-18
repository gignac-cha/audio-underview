import type { CrawlerRow } from '@audio-underview/supabase-connector';
import {
  BLANK_FORM,
  computeIsDirty,
  deriveFormState,
  validateDeclaredEnvironmentVariableName,
  type FormState,
} from './crawler-form-helpers.ts';

function createCrawler(overrides: Partial<CrawlerRow> = {}): CrawlerRow {
  return {
    id: 'c1',
    user_uuid: 'u1',
    name: 'Detail Crawler',
    type: 'web',
    url_pattern: '^https://example\\.com',
    code: '(body) => body.length',
    input_schema: { body: 'string' },
    output_schema: { count: 'number' },
    environment_variable_names: ['API_TOKEN'],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    ...overrides,
  } as CrawlerRow;
}

describe('deriveFormState', () => {
  test('takes the declared environment variable names of the crawler', () => {
    const form = deriveFormState(createCrawler({ environment_variable_names: ['API_TOKEN', 'BLOG_A_TOKEN'] }));

    expect(form.environment_variable_names).toEqual(['API_TOKEN', 'BLOG_A_TOKEN']);
  });

  test('reads a crawler without the declaration as an empty list', () => {
    const crawler = createCrawler() as Partial<CrawlerRow>;
    delete crawler.environment_variable_names;

    expect(deriveFormState(crawler as CrawlerRow).environment_variable_names).toEqual([]);
  });

  test('a blank form declares nothing', () => {
    expect(BLANK_FORM.environment_variable_names).toEqual([]);
  });
});

describe('computeIsDirty', () => {
  const pristine: FormState = deriveFormState(createCrawler({ environment_variable_names: ['A_TOKEN', 'B_TOKEN'] }));

  test('is clean when nothing differs, even for another array with the same names', () => {
    expect(computeIsDirty({ ...pristine, environment_variable_names: ['A_TOKEN', 'B_TOKEN'] }, pristine)).toBe(false);
  });

  test('is dirty when a name is added', () => {
    expect(computeIsDirty({ ...pristine, environment_variable_names: ['A_TOKEN', 'B_TOKEN', 'C_TOKEN'] }, pristine)).toBe(
      true,
    );
  });

  test('is dirty when a name is removed', () => {
    expect(computeIsDirty({ ...pristine, environment_variable_names: ['A_TOKEN'] }, pristine)).toBe(true);
  });

  test('is dirty when the names change their order', () => {
    expect(computeIsDirty({ ...pristine, environment_variable_names: ['B_TOKEN', 'A_TOKEN'] }, pristine)).toBe(true);
  });

  test('is dirty when another field changes', () => {
    expect(computeIsDirty({ ...pristine, code: 'return 1' }, pristine)).toBe(true);
  });

  test('is clean while there is no form or no pristine form', () => {
    expect(computeIsDirty(undefined, pristine)).toBe(false);
    expect(computeIsDirty(pristine, undefined)).toBe(false);
  });
});

describe('validateDeclaredEnvironmentVariableName', () => {
  test('accepts a new name that follows the rule', () => {
    expect(validateDeclaredEnvironmentVariableName('API_TOKEN', [])).toBeUndefined();
  });

  test('rejects a name that breaks the rule', () => {
    expect(validateDeclaredEnvironmentVariableName('api_token', [])).toContain('^[A-Z_][A-Z0-9_]{0,63}$');
    expect(validateDeclaredEnvironmentVariableName('', [])).toContain('^[A-Z_][A-Z0-9_]{0,63}$');
  });

  test('rejects a name that is declared already', () => {
    expect(validateDeclaredEnvironmentVariableName('API_TOKEN', ['API_TOKEN'])).toBe('API_TOKEN is already declared.');
  });

  test('rejects a 101st name', () => {
    const declared = Array.from({ length: 100 }, (_, index) => `NAME_${index}`);

    expect(validateDeclaredEnvironmentVariableName('ONE_MORE', declared)).toBe('A crawler can declare at most 100 names.');
    expect(validateDeclaredEnvironmentVariableName('ONE_MORE', declared.slice(0, 99))).toBeUndefined();
  });
});
