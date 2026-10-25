import { describe, test, expect } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatElapsed,
  formatPercent,
  formatRelativeTime,
  formatTokens,
  parseCreatedAtMilliseconds,
  shortID,
} from './formatting.ts';

describe('parseCreatedAtMilliseconds', () => {
  test('reads the ISO timestamp of a TIMESTAMPTZ with its offset', () => {
    expect(parseCreatedAtMilliseconds('2026-07-14T04:56:31.123456+00:00')).toBe(Date.parse('2026-07-14T04:56:31.123Z'));
    expect(parseCreatedAtMilliseconds('2026-07-14T13:56:31+09:00')).toBe(Date.parse('2026-07-14T04:56:31Z'));
  });

  test('answers undefined for text that is not a time', () => {
    expect(parseCreatedAtMilliseconds('not a date')).toBeUndefined();
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-14T05:00:00Z');

  test('renders seconds, minutes, and hours ago', () => {
    expect(formatRelativeTime(now - 32_000, now)).toBe('32s ago');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
  });

  test('falls back to a date beyond 24h', () => {
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toMatch(/Jul/);
  });
});

describe('duration and size formatting', () => {
  test('formats elapsed mm:ss', () => {
    expect(formatElapsed(83_000)).toBe('01:23');
  });

  test('formats durations in English', () => {
    expect(formatDuration(1_300)).toBe('1.3s');
    expect(formatDuration(64_000)).toBe('1m 4s');
  });

  test('formats bytes, tokens, percent and the short ID', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatTokens(5252)).toBe('5,252');
    expect(formatPercent(0.47)).toBe('47%');
    expect(shortID('c3f487b3-51d7-44df')).toBe('c3f487b3');
  });
});
