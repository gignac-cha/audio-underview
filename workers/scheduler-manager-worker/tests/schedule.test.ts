import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  isScheduleMinuteAllowed,
  isValidTimezone,
  isScheduleTimezoneAllowed,
  computeNextRunAt,
  resolveNextRunAt,
  schedulerRunInstanceID,
} from '../sources/schedule.ts';

const MOCK_SCHEDULER_ID = '00000000-0000-0000-0000-000000000010';

describe('schedule', () => {
  describe('DEFAULT_TIMEZONE', () => {
    it('is Asia/Seoul', () => {
      expect(DEFAULT_TIMEZONE).toBe('Asia/Seoul');
    });
  });

  describe('computeNextRunAt', () => {
    // Expected values were computed by hand; a mismatch is a finding, not something to adjust.
    // 2026-10-05 is a Monday.
    it.each([
      { cron: '0 7 * * *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-05T22:00:00.000Z' },
      { cron: '0 7 * * *', timezone: 'Asia/Seoul', after: '2026-10-04T21:59:59.999Z', expected: '2026-10-04T22:00:00.000Z' },
      { cron: '0 7 * * *', timezone: 'Asia/Seoul', after: '2026-10-04T22:00:00.000Z', expected: '2026-10-05T22:00:00.000Z' },
      { cron: '0 7 * * *', timezone: 'UTC', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-05T07:00:00.000Z' },
      { cron: '*/10 * * * *', timezone: 'Asia/Seoul', after: '2026-10-05T00:03:00.000Z', expected: '2026-10-05T00:10:00.000Z' },
      { cron: '0,30 9 * * 1-5', timezone: 'Asia/Seoul', after: '2026-10-02T09:00:00.000Z', expected: '2026-10-05T00:00:00.000Z' },
      { cron: '0 9 * * 7', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-11T00:00:00.000Z' },
      { cron: '5 9 * * *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-05T00:05:00.000Z' },
      { cron: '5/10 * * * *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-05T00:05:00.000Z' },
      { cron: '0 9 1 * *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-11-01T00:00:00.000Z' },
      // The 6th or a Sunday
      { cron: '0 9 6 * 0', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-06T00:00:00.000Z' },
      // An odd day that is a Monday
      { cron: '0 9 */2 * 1', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2026-10-19T00:00:00.000Z' },
      { cron: '0 0 29 2 *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: '2028-02-28T15:00:00.000Z' },
      // A local time that does not exist (clocks go forward on 2027-03-14)
      { cron: '30 2 * * *', timezone: 'America/New_York', after: '2027-03-13T12:00:00.000Z', expected: '2027-03-15T06:30:00.000Z' },
      // A local time that occurs twice (clocks go back on 2026-11-01)
      { cron: '30 1 * * *', timezone: 'America/New_York', after: '2026-11-01T05:00:00.000Z', expected: '2026-11-01T05:30:00.000Z' },
      { cron: '30 1 * * *', timezone: 'America/New_York', after: '2026-11-01T05:30:00.000Z', expected: '2026-11-02T06:30:00.000Z' },
      // Antarctica/Troll is UTC+0 in winter and UTC+2 in summer, switching at 01:00 UTC on
      // 2027-03-28 and 2027-10-31. The day after a 22-hour day:
      { cron: '30 0 * * 1', timezone: 'Antarctica/Troll', after: '2027-03-27T12:00:00.000Z', expected: '2027-03-28T22:30:00.000Z' },
      // A local time that occurs twice after clocks go back 2 hours:
      { cron: '30 2 * * *', timezone: 'Antarctica/Troll', after: '2027-10-31T01:00:00.000Z', expected: '2027-11-01T02:30:00.000Z' },
      // Pacific/Chatham is UTC+12:45 in winter and UTC+13:45 in summer. Its clocks go from 02:45
      // to 03:45 on 2026-09-27, not on the hour: 03:50 exists that day, 03:00 does not.
      { cron: '50 3 * * *', timezone: 'Pacific/Chatham', after: '2026-09-26T00:00:00.000Z', expected: '2026-09-26T14:05:00.000Z' },
      { cron: '0 3 * * *', timezone: 'Pacific/Chatham', after: '2026-09-26T00:00:00.000Z', expected: '2026-09-27T13:15:00.000Z' },
      { cron: '0 0 31 2 *', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: null },
      { cron: 'not a cron', timezone: 'Asia/Seoul', after: '2026-10-05T00:00:00.000Z', expected: null },
      { cron: '0 7 * * *', timezone: 'Not/AZone', after: '2026-10-05T00:00:00.000Z', expected: null },
    ])('returns $expected for $cron in $timezone after $after', ({ cron, timezone, after, expected }) => {
      const result = computeNextRunAt(cron, timezone, new Date(after));

      expect(result?.toISOString() ?? null).toBe(expected);
    });
  });

  describe('isScheduleMinuteAllowed', () => {
    it.each([
      '0 9 * * *',
      '30 9 * * *',
      '0,30 9 * * *',
      '0,10,20,30,40,50 * * * *',
      '*/10 * * * *',
      '*/20 * * * *',
      '*/30 * * * *',
    ])('allows "%s"', (cronExpression) => {
      expect(isScheduleMinuteAllowed(cronExpression)).toBe(true);
    });

    it.each([
      '* * * * *',
      '*/5 * * * *',
      '*/15 * * * *',
      '5 9 * * *',
      '0,15 9 * * *',
      '0-50 * * * *',
      '0-50/10 * * * *',
      '60 9 * * *',
    ])('rejects "%s"', (cronExpression) => {
      expect(isScheduleMinuteAllowed(cronExpression)).toBe(false);
    });
  });

  describe('isValidTimezone', () => {
    it.each(['Asia/Seoul', 'UTC', 'America/New_York'])('accepts "%s"', (timezone) => {
      expect(isValidTimezone(timezone)).toBe(true);
    });

    it.each([
      { label: 'Not/AZone', timezone: 'Not/AZone' },
      { label: 'KST', timezone: 'KST' },
      { label: '+09:00', timezone: '+09:00' },
      { label: 'the empty string', timezone: '' },
      { label: 'a 65-character string', timezone: 'A'.repeat(65) },
    ])('rejects $label', ({ timezone }) => {
      expect(isValidTimezone(timezone)).toBe(false);
    });
  });

  describe('isScheduleTimezoneAllowed', () => {
    const at = new Date('2026-10-05T00:00:00.000Z');

    it.each([
      { label: 'Asia/Seoul (+9)', timezone: 'Asia/Seoul' },
      { label: 'UTC', timezone: 'UTC' },
      { label: 'America/New_York (-5/-4)', timezone: 'America/New_York' },
      { label: 'Asia/Kolkata (+5:30)', timezone: 'Asia/Kolkata' },
      { label: 'Australia/Lord_Howe (+10:30/+11)', timezone: 'Australia/Lord_Howe' },
      // A negative offset off the hour: -3:30 is -210 minutes.
      { label: 'America/St_Johns (-3:30/-2:30)', timezone: 'America/St_Johns' },
    ])('accepts $label', ({ timezone }) => {
      expect(isScheduleTimezoneAllowed(timezone, at)).toBe(true);
    });

    it.each([
      { label: 'Asia/Kathmandu (+5:45)', timezone: 'Asia/Kathmandu' },
      { label: 'Pacific/Chatham (+12:45/+13:45)', timezone: 'Pacific/Chatham' },
      { label: 'Australia/Eucla (+8:45)', timezone: 'Australia/Eucla' },
      { label: 'an invalid time zone', timezone: 'Not/AZone' },
    ])('rejects $label', ({ timezone }) => {
      expect(isScheduleTimezoneAllowed(timezone, at)).toBe(false);
    });

    it('decides by the offsets in the UTC year of `at`', () => {
      // Asia/Kathmandu was UTC+5:30 until it moved to UTC+5:45 at the start of 1986.
      expect(isScheduleTimezoneAllowed('Asia/Kathmandu', new Date('1985-07-01T00:00:00.000Z'))).toBe(true);
      expect(isScheduleTimezoneAllowed('Asia/Kathmandu', new Date('1986-07-01T00:00:00.000Z'))).toBe(false);
    });
  });

  describe('resolveNextRunAt', () => {
    const after = new Date('2026-10-05T00:00:00.000Z');

    it('returns null when the scheduler is disabled', () => {
      const result = resolveNextRunAt({ cron_expression: '0 7 * * *', timezone: 'Asia/Seoul', is_enabled: false }, after);

      expect(result).toBeNull();
    });

    it('returns null when the scheduler has no cron expression', () => {
      const result = resolveNextRunAt({ cron_expression: null, timezone: 'Asia/Seoul', is_enabled: true }, after);

      expect(result).toBeNull();
    });

    it('returns the ISO string of the next run when enabled with a cron expression', () => {
      const result = resolveNextRunAt({ cron_expression: '0 7 * * *', timezone: 'Asia/Seoul', is_enabled: true }, after);

      expect(result).toBe('2026-10-05T22:00:00.000Z');
    });
  });

  describe('schedulerRunInstanceID', () => {
    it('joins the scheduler ID and the occurrence in epoch minutes', () => {
      const result = schedulerRunInstanceID(MOCK_SCHEDULER_ID, new Date('2026-10-05T22:00:00.000Z'));

      expect(result).toBe('00000000-0000-0000-0000-000000000010-29853960');
    });
  });
});
