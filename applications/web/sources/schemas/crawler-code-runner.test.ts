import {
  crawlerRunRequestSchema,
  crawlerRunSuccessResponseSchema,
  crawlerRunErrorResponseSchema,
  MAX_CODE_LENGTH,
} from './crawler-code-runner.ts';

describe('MAX_CODE_LENGTH', () => {
  test('equals 10000', () => {
    expect(MAX_CODE_LENGTH).toBe(10_000);
  });
});

describe('crawlerRunRequestSchema', () => {
  test('parses valid request with type "test"', () => {
    const data = { type: 'test', url: 'https://example.com', code: 'console.log("hi")' };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(true);
  });

  test('parses valid request with type "run"', () => {
    const data = { type: 'run', url: 'https://example.com/page', code: 'return 1;' };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(true);
  });

  test('fails on invalid type', () => {
    const data = { type: 'invalid', url: 'https://example.com', code: 'code' };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(false);
  });

  test('fails on invalid url', () => {
    const data = { type: 'test', url: 'not-a-url', code: 'code' };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(false);
  });

  test('fails on empty code', () => {
    const data = { type: 'test', url: 'https://example.com', code: '' };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(false);
  });

  test('fails when code exceeds MAX_CODE_LENGTH', () => {
    const data = { type: 'test', url: 'https://example.com', code: 'x'.repeat(MAX_CODE_LENGTH + 1) };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(false);
  });

  test('accepts code at exactly MAX_CODE_LENGTH', () => {
    const data = { type: 'test', url: 'https://example.com', code: 'x'.repeat(MAX_CODE_LENGTH) };
    expect(crawlerRunRequestSchema.safeParse(data).success).toBe(true);
  });
});

describe('crawlerRunSuccessResponseSchema', () => {
  test('parses valid success response', () => {
    const data = { type: 'test', result: { foo: 'bar' } };
    expect(crawlerRunSuccessResponseSchema.safeParse(data).success).toBe(true);
  });

  test('allows null result', () => {
    const data = { type: 'run', result: null };
    expect(crawlerRunSuccessResponseSchema.safeParse(data).success).toBe(true);
  });
});

describe('crawlerRunErrorResponseSchema', () => {
  test('parses valid error response', () => {
    const data = { error: 'SyntaxError', error_description: 'Unexpected token' };
    expect(crawlerRunErrorResponseSchema.safeParse(data).success).toBe(true);
  });

  test('fails on missing fields', () => {
    expect(crawlerRunErrorResponseSchema.safeParse({}).success).toBe(false);
    expect(crawlerRunErrorResponseSchema.safeParse({ error: 'e' }).success).toBe(false);
  });
});
