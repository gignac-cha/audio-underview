import { describe, it, expect } from 'vitest';
import { validateCrawlerRunOutcome } from '../sources/index.ts';

// validateCrawlerRunOutcome: the cases beyond crawler-run-outcome.test.ts.

const entry = { level: 'log', message: 'hello', timestamp: '2026-10-13T00:00:00.000Z' };

const completed = { status: 'completed', type: 'data', result: { title: 'Example' }, logs: [entry], logs_truncated: false };

const failed = {
  status: 'failed',
  type: 'web',
  error_code: 'execution_failed',
  error: 'CodeRunner error 422: [execution_failed] boom',
  error_description: 'boom',
  logs: [entry],
  logs_truncated: true,
};

describe('validateCrawlerRunOutcome', () => {
  it('accepts every log level and keeps the item_index of an entry', () => {
    const logs = ['debug', 'info', 'log', 'warn', 'error'].map((level, index) => ({ ...entry, level, item_index: index }));

    expect(validateCrawlerRunOutcome({ ...completed, logs }).logs).toEqual(logs);
  });

  it('accepts a failed outcome of either type, and an outcome without logs', () => {
    expect(validateCrawlerRunOutcome({ ...failed, type: 'data' })).toEqual({ ...failed, type: 'data' });
    expect(validateCrawlerRunOutcome({ ...completed, logs: [] }).logs).toEqual([]);
  });

  it('accepts a result of any JSON type, false and zero and the empty string included', () => {
    for (const result of [false, 0, '', [], {}, 'text']) {
      expect(validateCrawlerRunOutcome({ ...completed, result })).toEqual({ ...completed, result });
    }
  });

  it('drops the fields it does not know, also of a failed outcome', () => {
    expect(validateCrawlerRunOutcome({ ...failed, extra: 'x', logs: [{ ...entry, extra: 'y' }] })).toEqual(failed);
  });

  it('rejects a value that is not an object', () => {
    for (const value of [null, undefined, 'text', 42, [completed], [failed]]) {
      expect(() => validateCrawlerRunOutcome(value)).toThrow(/^Invalid CrawlerRunOutcome:/);
    }
  });

  it('rejects an outcome without a status, with an unknown status, or with an unknown type', () => {
    const { status: _status, ...withoutStatus } = completed;
    expect(() => validateCrawlerRunOutcome(withoutStatus)).toThrow(/^Invalid CrawlerRunOutcome:/);
    expect(() => validateCrawlerRunOutcome({ ...completed, status: 'running' })).toThrow(/^Invalid CrawlerRunOutcome:/);
    expect(() => validateCrawlerRunOutcome({ ...completed, type: 'other' })).toThrow(/^Invalid CrawlerRunOutcome:/);
    const { type: _type, ...withoutType } = completed;
    expect(() => validateCrawlerRunOutcome(withoutType)).toThrow(/^Invalid CrawlerRunOutcome:/);
  });

  it('rejects logs that are missing or not a list, and logs_truncated that is missing or not a boolean', () => {
    for (const logs of [undefined, null, 'text', { 0: entry }]) {
      expect(() => validateCrawlerRunOutcome({ ...completed, logs })).toThrow(/^Invalid CrawlerRunOutcome:/);
    }
    for (const logsTruncated of [undefined, null, 'no', 0, 1]) {
      expect(() => validateCrawlerRunOutcome({ ...completed, logs_truncated: logsTruncated })).toThrow(/^Invalid CrawlerRunOutcome:/);
    }
  });

  it('rejects a log entry that is not valid, however it is wrong, and says which entry', () => {
    const invalidEntries = [
      null,
      'text',
      [],
      { ...entry, level: 'trace' },
      { ...entry, level: undefined },
      { ...entry, message: 1 },
      { ...entry, message: undefined },
      { ...entry, timestamp: undefined },
      { ...entry, timestamp: 1 },
      { ...entry, item_index: 1.5 },
      { ...entry, item_index: '1' },
      { ...entry, item_index: -1 },
    ];
    for (const invalidEntry of invalidEntries) {
      expect(() => validateCrawlerRunOutcome({ ...completed, logs: [entry, invalidEntry] })).toThrow(/^Invalid CrawlerRunOutcome: .*\b1\b/);
    }
  });

  it('rejects a failed outcome without the error fields as strings, and a completed outcome without a result', () => {
    for (const overrides of [{ error_code: undefined }, { error_code: 1 }, { error: undefined }, { error: null }, { error_description: 1 }, { error_description: undefined }]) {
      expect(() => validateCrawlerRunOutcome({ ...failed, ...overrides })).toThrow(/^Invalid CrawlerRunOutcome:/);
    }
    const { result: _result, ...withoutResult } = completed;
    expect(() => validateCrawlerRunOutcome(withoutResult)).toThrow(/^Invalid CrawlerRunOutcome:/);
  });
});
