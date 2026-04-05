import { describe, it, expect } from 'vitest';
import { resolveHTTPStatus } from '../sources/handlers/scheduler-execution.ts';
import { validateCrawlerExecuteResult } from '@audio-underview/worker-tools';

describe('resolveHTTPStatus', () => {
  it('returns 200 for completed', () => {
    expect(resolveHTTPStatus('completed', null)).toBe(200);
  });

  it('returns 200 for partially_failed', () => {
    expect(resolveHTTPStatus('partially_failed', null)).toBe(200);
  });

  it('returns 200 for failed with no error message', () => {
    expect(resolveHTTPStatus('failed', null)).toBe(200);
  });

  it('returns 500 for failed with unknown error', () => {
    expect(resolveHTTPStatus('failed', 'Something went wrong')).toBe(500);
  });

  it('returns 408 for pipeline timeout', () => {
    expect(resolveHTTPStatus('failed', 'Pipeline execution timed out after 5 minutes')).toBe(408);
  });

  it('returns 422 for invalid input_schema', () => {
    expect(resolveHTTPStatus('failed', 'Invalid input_schema: expected object, got string')).toBe(422);
  });

  it('returns 422 for fan_out_field error', () => {
    expect(resolveHTTPStatus('failed', 'Stage 1: fan_out_field "items" not found in input')).toBe(422);
  });

  it('returns 502 for code-runner error', () => {
    expect(resolveHTTPStatus('failed', 'CodeRunner error 500: [server_error] Server returned 500')).toBe(502);
  });

  it('returns 502 for invalid RPC response', () => {
    expect(resolveHTTPStatus('failed', 'Invalid CrawlerExecuteResult: expected object')).toBe(502);
  });

  it('returns 503 for database error', () => {
    expect(resolveHTTPStatus('failed', 'Supabase request failed')).toBe(503);
  });

  it('returns 503 for database connection error', () => {
    expect(resolveHTTPStatus('failed', 'database connection refused')).toBe(503);
  });

  it('returns 200 for pending status', () => {
    expect(resolveHTTPStatus('pending', null)).toBe(200);
  });

  it('returns 200 for running status', () => {
    expect(resolveHTTPStatus('running', null)).toBe(200);
  });
});

describe('validateCrawlerExecuteResult', () => {
  it('accepts valid web result', () => {
    const result = validateCrawlerExecuteResult({ type: 'web', result: { data: 'hello' } });
    expect(result.type).toBe('web');
    expect(result.result).toEqual({ data: 'hello' });
  });

  it('accepts valid data result with null', () => {
    const result = validateCrawlerExecuteResult({ type: 'data', result: null });
    expect(result.type).toBe('data');
    expect(result.result).toBeNull();
  });

  it('throws on null input', () => {
    expect(() => validateCrawlerExecuteResult(null)).toThrow('expected object');
  });

  it('throws on non-object input', () => {
    expect(() => validateCrawlerExecuteResult('string')).toThrow('expected object');
  });

  it('throws on invalid type', () => {
    expect(() => validateCrawlerExecuteResult({ type: 'unknown', result: {} })).toThrow("expected type 'web' or 'data'");
  });

  it('throws on missing result field', () => {
    expect(() => validateCrawlerExecuteResult({ type: 'web' })).toThrow('missing result field');
  });
});
