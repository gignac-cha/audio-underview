import { describe, test, expect } from 'vitest';
import { isScheduleMinuteAllowed } from './schedule-minute.ts';

describe('isScheduleMinuteAllowed', () => {
  test.each([
    '0 9 * * *',
    '30 9 * * *',
    '0,30 9 * * *',
    '0,10,20,30,40,50 * * * *',
    '*/10 * * * *',
    '*/20 * * * *',
    '*/30 * * * *',
  ])('allows %s', (cronExpression) => {
    expect(isScheduleMinuteAllowed(cronExpression)).toBe(true);
  });

  test.each([
    '* * * * *',
    '*/5 * * * *',
    '*/15 * * * *',
    '5 9 * * *',
    '0,15 9 * * *',
    '0-50 * * * *',
    '0-50/10 * * * *',
    '60 9 * * *',
  ])('rejects %s', (cronExpression) => {
    expect(isScheduleMinuteAllowed(cronExpression)).toBe(false);
  });
});
