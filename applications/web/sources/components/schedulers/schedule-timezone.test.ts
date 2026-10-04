import { describe, test, expect, afterEach, vi } from 'vitest';
import {
  browserTimezone,
  defaultScheduleTimezone,
  formatInTimezone,
  isScheduleTimezoneAllowed,
  listScheduleTimezones,
} from './schedule-timezone.ts';

const AT = new Date('2026-10-04T00:00:00.000Z');

// Pretends the browser runs in `timezone` without touching how dates are formatted.
function stubBrowserTimezone(timezone: string | undefined) {
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: timezone } as Intl.ResolvedDateTimeFormatOptions;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isScheduleTimezoneAllowed', () => {
  test.each([
    'Asia/Seoul',
    'UTC',
    'America/New_York',
    'Asia/Kolkata',
    'Australia/Lord_Howe',
  ])('allows %s', (timezone) => {
    expect(isScheduleTimezoneAllowed(timezone, AT)).toBe(true);
  });

  test.each([
    'Asia/Kathmandu',
    'Pacific/Chatham',
    'Australia/Eucla',
    'Not/AZone',
    'KST',
    '+09:00',
    '',
    'A'.repeat(65),
  ])('rejects %s', (timezone) => {
    expect(isScheduleTimezoneAllowed(timezone, AT)).toBe(false);
  });
});

describe('listScheduleTimezones', () => {
  const timezones = listScheduleTimezones(AT);

  test('contains Asia/Seoul and UTC', () => {
    expect(timezones).toContain('Asia/Seoul');
    expect(timezones).toContain('UTC');
  });

  test('leaves out zones whose UTC offset is off the 10-minute grid', () => {
    // The browser lists Kathmandu under its older name.
    expect(timezones).not.toContain('Asia/Katmandu');
    expect(timezones).not.toContain('Pacific/Chatham');
    expect(timezones).not.toContain('Australia/Eucla');
  });

  test('lists only allowed zones, once each, sorted', () => {
    expect(timezones.every((timezone) => isScheduleTimezoneAllowed(timezone, AT))).toBe(true);
    expect(new Set(timezones).size).toBe(timezones.length);
    expect(timezones).toEqual([...timezones].sort());
  });
});

describe('browserTimezone', () => {
  test('is the time zone the browser resolves', () => {
    stubBrowserTimezone('America/New_York');
    expect(browserTimezone()).toBe('America/New_York');
  });

  test('falls back to UTC when the browser resolves none', () => {
    stubBrowserTimezone(undefined);
    expect(browserTimezone()).toBe('UTC');
  });
});

describe('defaultScheduleTimezone', () => {
  test('is the browser zone when schedules may use it', () => {
    stubBrowserTimezone('America/New_York');
    expect(defaultScheduleTimezone(AT)).toBe('America/New_York');
  });

  test('falls back to UTC when the browser zone is off the 10-minute grid', () => {
    stubBrowserTimezone('Asia/Kathmandu');
    expect(defaultScheduleTimezone(AT)).toBe('UTC');
  });
});

describe('formatInTimezone', () => {
  test('shows the wall clock of the given zone', () => {
    // 01:30 UTC is 10:30 in Asia/Seoul (UTC+9), so it reads like 10:30 UTC.
    const inSeoul = formatInTimezone('2026-10-06T01:30:00.000Z', 'Asia/Seoul');
    expect(inSeoul).toBe(formatInTimezone('2026-10-06T10:30:00.000Z', 'UTC'));
    expect(inSeoul).toContain('2026');
    expect(inSeoul).toContain('10:30');
  });
});
