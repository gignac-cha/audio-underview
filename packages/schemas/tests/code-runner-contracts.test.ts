import { describe, expect, it } from 'vitest';
import {
  codeRunnerResultSchema,
  runCodeRequestBodySchema,
} from '../sources/code-runner/contracts.ts';

describe('runCodeRequestBodySchema', () => {
  it('accepts a web request', () => {
    const result = runCodeRequestBodySchema.safeParse({
      type: 'web',
      mode: 'test',
      url: 'https://example.com/page',
      code: '(body) => body.length',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a data request with null data', () => {
    const result = runCodeRequestBodySchema.safeParse({
      type: 'data',
      mode: 'run',
      data: null,
      code: '(input) => input',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown type', () => {
    expect(
      runCodeRequestBodySchema.safeParse({ type: 'file', mode: 'test', code: '() => 1' }).success,
    ).toBe(false);
  });

  it('rejects an invalid URL for web requests', () => {
    expect(
      runCodeRequestBodySchema.safeParse({
        type: 'web',
        mode: 'test',
        url: 'not a url',
        code: '() => 1',
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid mode', () => {
    expect(
      runCodeRequestBodySchema.safeParse({
        type: 'data',
        mode: 'production',
        data: {},
        code: '() => 1',
      }).success,
    ).toBe(false);
  });
});

describe('codeRunnerResultSchema', () => {
  it('accepts a result payload', () => {
    expect(
      codeRunnerResultSchema.safeParse({ type: 'web', mode: 'run', result: [1, 2] }).success,
    ).toBe(true);
  });

  it('accepts a missing result key (사용자 코드가 undefined 반환)', () => {
    expect(codeRunnerResultSchema.safeParse({ type: 'data', mode: 'test' }).success).toBe(true);
  });

  it('rejects an invalid mode', () => {
    expect(codeRunnerResultSchema.safeParse({ type: 'web', mode: 'x', result: 1 }).success).toBe(
      false,
    );
  });
});
