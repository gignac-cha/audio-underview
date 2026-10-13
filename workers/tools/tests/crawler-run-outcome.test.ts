import { describe, it, expect } from 'vitest';
import {
  validateCrawlerRunOutcome,
  CRAWLER_LOG_MAXIMUM_COST,
  CRAWLER_LOG_MAXIMUM_ENTRIES,
  CRAWLER_LOG_ENTRY_OVERHEAD,
} from '../sources/index.ts';

const logs = [
  { level: 'log', message: 'first', timestamp: '2026-10-13T00:00:00.000Z' },
  { level: 'error', message: 'second', timestamp: '2026-10-13T00:00:01.000Z', item_index: 0 },
];

function completedOutcome(overrides: Record<string, unknown> = {}) {
  return { status: 'completed', type: 'data', result: { title: 'a' }, logs, logs_truncated: false, ...overrides };
}

function failedOutcome(overrides: Record<string, unknown> = {}) {
  return {
    status: 'failed',
    type: 'web',
    error_code: 'execution_failed',
    error: 'CodeRunner error 422: [execution_failed] boom',
    error_description: 'boom',
    logs,
    logs_truncated: true,
    ...overrides,
  };
}

describe('log limits', () => {
  it('are the documented values', () => {
    expect(CRAWLER_LOG_MAXIMUM_COST).toBe(65_536);
    expect(CRAWLER_LOG_MAXIMUM_ENTRIES).toBe(1_000);
    expect(CRAWLER_LOG_ENTRY_OVERHEAD).toBe(64);
  });
});

describe('validateCrawlerRunOutcome', () => {
  it('accepts a completed outcome', () => {
    expect(validateCrawlerRunOutcome(completedOutcome())).toEqual(completedOutcome());
  });

  it('accepts a completed outcome whose result is null', () => {
    expect(validateCrawlerRunOutcome(completedOutcome({ result: null }))).toEqual(completedOutcome({ result: null }));
  });

  it('accepts a failed outcome', () => {
    expect(validateCrawlerRunOutcome(failedOutcome())).toEqual(failedOutcome());
  });

  it('keeps only the fields of the contract', () => {
    const outcome = validateCrawlerRunOutcome({
      ...completedOutcome(),
      extra: 'dropped',
      logs: [{ ...logs[0], extra: 'dropped' }],
    });
    expect(outcome).toEqual(completedOutcome({ logs: [logs[0]] }));
  });

  it.each([
    ['null', null, 'expected object'],
    ['a string', 'completed', 'expected object'],
    ['an array', [], 'expected object'],
    ['an unknown status', completedOutcome({ status: 'running' }), "expected status 'completed' or 'failed', got 'running'"],
    ['an unknown type', completedOutcome({ type: 'other' }), "expected type 'web' or 'data', got 'other'"],
    ['logs that are not an array', completedOutcome({ logs: null }), 'logs must be an array'],
    ['logs_truncated that is not a boolean', completedOutcome({ logs_truncated: 'no' }), 'logs_truncated must be a boolean'],
    ['a completed outcome without result', (({ result: _result, ...rest }) => rest)(completedOutcome()), 'missing result field'],
    ['a failed outcome without error_code', failedOutcome({ error_code: undefined }), 'error_code must be a string'],
    ['a failed outcome without error', failedOutcome({ error: 1 }), 'error must be a string'],
    ['a failed outcome without error_description', failedOutcome({ error_description: null }), 'error_description must be a string'],
    ['a log entry that is not an object', completedOutcome({ logs: ['text'] }), 'log entry 0 must be an object'],
    ['a log entry with an unknown level', completedOutcome({ logs: [{ ...logs[0], level: 'trace' }] }), 'log entry 0 has an unknown level'],
    ['a log entry without a message', completedOutcome({ logs: [logs[0], { ...logs[0], message: 1 }] }), 'log entry 1 must have a string message'],
    ['a log entry without a timestamp', completedOutcome({ logs: [{ ...logs[0], timestamp: undefined }] }), 'log entry 0 must have a string timestamp'],
    ['a log entry with a negative item_index', completedOutcome({ logs: [{ ...logs[0], item_index: -1 }] }), 'log entry 0 has an invalid item_index'],
    ['a log entry with a fractional item_index', completedOutcome({ logs: [{ ...logs[0], item_index: 0.5 }] }), 'log entry 0 has an invalid item_index'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateCrawlerRunOutcome(value)).toThrow(`Invalid CrawlerRunOutcome: ${message}`);
  });

  it('starts every error message with Invalid CrawlerRunOutcome:', () => {
    for (const value of [undefined, 42, completedOutcome({ status: 'x' }), failedOutcome({ error: undefined })]) {
      try {
        validateCrawlerRunOutcome(value);
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message.startsWith('Invalid CrawlerRunOutcome:')).toBe(true);
      }
    }
  });
});
