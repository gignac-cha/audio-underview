import { describe, expect, it } from 'vitest';
import { saveCrawlerBodySchema } from '../sources/crawlers/requests.ts';
import { MAXIMUM_CRAWLER_CODE_LENGTH } from '../sources/common/limits.ts';

const validWebBody = {
  name: 'My Crawler',
  type: 'web',
  url_pattern: '^https://example\\.com/.*$',
  code: '(input) => input.length',
};

const validDataBody = {
  name: 'Data Crawler',
  type: 'data',
  input_schema: { items: { default: [] } },
  code: '(input) => input',
};

describe('saveCrawlerBodySchema', () => {
  it('accepts a valid web crawler and applies the default type', () => {
    const { type: _type, ...withoutType } = validWebBody;
    const parsed = saveCrawlerBodySchema.parse(withoutType);
    expect(parsed.type).toBe('web');
  });

  it('accepts a valid data crawler', () => {
    expect(saveCrawlerBodySchema.safeParse(validDataBody).success).toBe(true);
  });

  it('rejects a whitespace-only name', () => {
    expect(saveCrawlerBodySchema.safeParse({ ...validWebBody, name: '   ' }).success).toBe(false);
  });

  it('rejects a web crawler without url_pattern', () => {
    const { url_pattern: _pattern, ...body } = validWebBody;
    const result = saveCrawlerBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects a data crawler without input_schema', () => {
    const { input_schema: _schema, ...body } = validDataBody;
    expect(saveCrawlerBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects an uncompilable url_pattern', () => {
    const result = saveCrawlerBodySchema.safeParse({ ...validWebBody, url_pattern: '([' });
    expect(result.success).toBe(false);
  });

  it('rejects an array input_schema', () => {
    expect(
      saveCrawlerBodySchema.safeParse({ ...validDataBody, input_schema: [] }).success,
    ).toBe(false);
  });

  it(`rejects code longer than ${MAXIMUM_CRAWLER_CODE_LENGTH} characters`, () => {
    const code = `(input) => ${'x'.repeat(MAXIMUM_CRAWLER_CODE_LENGTH)}`;
    expect(saveCrawlerBodySchema.safeParse({ ...validWebBody, code }).success).toBe(false);
  });
});
