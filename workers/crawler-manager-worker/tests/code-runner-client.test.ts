import { describe, it, expect } from 'vitest';
import { validateCodeRunnerResult } from '../sources/code-runner-client.ts';

// Moved from crawler-executor.test.ts, which went with crawler-executor.ts
describe('validateCodeRunnerResult', () => {
  it('accepts valid web result', () => {
    const result = validateCodeRunnerResult({ type: 'web', mode: 'run', result: { data: 'ok' } });
    expect(result.type).toBe('web');
    expect(result.mode).toBe('run');
    expect(result.result).toEqual({ data: 'ok' });
  });

  it('accepts valid result with null', () => {
    const result = validateCodeRunnerResult({ type: 'data', mode: 'test', result: null });
    expect(result.type).toBe('data');
    expect(result.result).toBeNull();
  });

  it('throws on null input', () => {
    expect(() => validateCodeRunnerResult(null)).toThrow('Expected object from code-runner');
  });

  it('throws on non-object input', () => {
    expect(() => validateCodeRunnerResult('string')).toThrow('Expected object from code-runner');
  });

  it('throws on invalid type', () => {
    expect(() => validateCodeRunnerResult({ type: 'unknown', mode: 'run', result: {} })).toThrow("Expected type 'web' or 'data'");
  });

  it('throws on invalid mode', () => {
    expect(() => validateCodeRunnerResult({ type: 'web', mode: 'unknown', result: {} })).toThrow("Expected mode 'test' or 'run'");
  });

  it('throws on missing result field', () => {
    expect(() => validateCodeRunnerResult({ type: 'web', mode: 'run' })).toThrow('Missing result field');
  });
});
