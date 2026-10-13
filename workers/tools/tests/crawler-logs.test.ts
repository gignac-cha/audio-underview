import { describe, it, expect } from 'vitest';
import { type CrawlerLogEntry, limitCrawlerLogs } from '../sources/index.ts';

function entry(message: string, level: CrawlerLogEntry['level'] = 'log'): CrawlerLogEntry {
  return { level, message, timestamp: '2026-10-13T00:00:00.000Z' };
}

describe('limitCrawlerLogs', () => {
  it('keeps logs within the limits as they are', () => {
    const logs = [entry('a'), { ...entry('b'), item_index: 3 }];

    expect(limitCrawlerLogs(logs)).toEqual({ logs, truncated: false });
  });

  it('cuts the entry that crosses a cost of 65536 and drops the entries after it', () => {
    // 61 entries of 1000 characters cost 61 * 1064 = 64904; the 62nd has 632 left, 568 for its message
    const { logs, truncated } = limitCrawlerLogs(Array.from({ length: 70 }, () => entry('a'.repeat(1000))));

    expect(logs).toHaveLength(62);
    expect(logs[61].message).toBe('a'.repeat(568));
    expect(truncated).toBe(true);
  });

  it('keeps at most 1000 entries, even of empty messages', () => {
    expect(limitCrawlerLogs(Array.from({ length: 1000 }, () => entry('')))).toMatchObject({ truncated: false });

    const { logs, truncated } = limitCrawlerLogs(Array.from({ length: 1001 }, () => entry('')));

    expect(logs).toHaveLength(1000);
    expect(truncated).toBe(true);
  });

  it('replaces NUL and unpaired surrogates', () => {
    expect(limitCrawlerLogs([entry('a\u0000b \ud800')]).logs[0].message).toBe('a�b �');
  });

  describe('with a trailing entry', () => {
    it('keeps logs within the limits as they are', () => {
      const logs = [entry('before'), entry('x'.repeat(10_000), 'error')];

      expect(limitCrawlerLogs(logs, { trailingEntryMaximumLength: 4000 })).toEqual({ logs, truncated: false });
    });

    it('keeps the last entry outside the limits, whole up to its maximum length', () => {
      const logs = [...Array.from({ length: 1000 }, () => entry('')), entry('e'.repeat(4000), 'error')];

      const limited = limitCrawlerLogs(logs, { trailingEntryMaximumLength: 4000 });

      expect(limited.logs).toHaveLength(1001);
      expect(limited.logs[1000]).toEqual(entry('e'.repeat(4000), 'error'));
      expect(limited.truncated).toBe(false);
    });

    it('cuts the last entry to its maximum length and the others to the limits', () => {
      const logs = [...Array.from({ length: 1500 }, () => entry('')), entry('e'.repeat(300_000), 'error')];

      const limited = limitCrawlerLogs(logs, { trailingEntryMaximumLength: 4000 });

      expect(limited.logs).toHaveLength(1001);
      expect(limited.logs[1000]).toEqual(entry('e'.repeat(4000), 'error'));
      expect(limited.truncated).toBe(true);
    });

    it('cuts a last entry that is too long alone', () => {
      const limited = limitCrawlerLogs([entry('e'.repeat(70_000), 'error')], { trailingEntryMaximumLength: 4000 });

      expect(limited).toEqual({ logs: [entry('e'.repeat(4000), 'error')], truncated: true });
    });
  });
});
