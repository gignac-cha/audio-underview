import { describe, expect, it } from 'vitest';
import {
  cronExpressionMatchesDate,
  isValidCronExpression,
} from '../sources/schedulers/cron.ts';

describe('isValidCronExpression', () => {
  it.each([
    '* * * * *',
    '0 0 * * *',
    '*/5 * * * *',
    '0 9-17 * * 1-5',
    '0,30 * * * *',
    '15 2 1 1 0',
    '0 0 * * 7', // 요일 7 = 일요일
    '10-20/2 * * * *',
  ])('accepts %s', (expression) => {
    expect(isValidCronExpression(expression)).toBe(true);
  });

  it.each([
    ['', '빈 문자열'],
    ['* * * *', '필드 4개'],
    ['* * * * * *', '필드 6개'],
    ['60 * * * *', '분 범위 초과'],
    ['* 24 * * *', '시 범위 초과'],
    ['* * 0 * *', '일 최소 미달'],
    ['* * 32 * *', '일 범위 초과'],
    ['* * * 13 *', '월 범위 초과'],
    ['* * * * 8', '요일 범위 초과'],
    ['5-2 * * * *', '역전 범위'],
    ['*/0 * * * *', 'step 0'],
    ['abc * * * *', '숫자 아님'],
    ['1,2,x * * * *', '리스트에 무효 항목'],
  ])('rejects %s (%s)', (expression) => {
    expect(isValidCronExpression(expression)).toBe(false);
  });
});

describe('cronExpressionMatchesDate (UTC)', () => {
  // 2026-07-06 09:30 UTC — 월요일
  const monday = new Date('2026-07-06T09:30:00Z');

  it.each([
    '* * * * *',
    '30 9 * * *',
    '*/10 * * * *',
    '30 9 6 7 *',
    '30 9 * * 1',
    '0,30 9-17 * * 1-5',
  ])('matches %s', (expression) => {
    expect(cronExpressionMatchesDate(expression, monday)).toBe(true);
  });

  it.each(['31 9 * * *', '30 10 * * *', '30 9 * * 0', '30 9 7 7 *', '30 9 * 8 *'])(
    'does not match %s',
    (expression) => {
      expect(cronExpressionMatchesDate(expression, monday)).toBe(false);
    },
  );

  it('treats weekday 7 as Sunday', () => {
    const sunday = new Date('2026-07-05T00:00:00Z');
    expect(cronExpressionMatchesDate('0 0 * * 7', sunday)).toBe(true);
    expect(cronExpressionMatchesDate('0 0 * * 0', sunday)).toBe(true);
  });

  it('combines restricted day-of-month and day-of-week with OR (표준 cron)', () => {
    // 6일(월요일): 일=6 매칭, 요일=일요일(0) 불일치 → OR라서 매칭
    expect(cronExpressionMatchesDate('30 9 6 * 0', monday)).toBe(true);
    // 일=7 불일치, 요일=월(1) 매칭 → OR라서 매칭
    expect(cronExpressionMatchesDate('30 9 7 * 1', monday)).toBe(true);
    // 둘 다 불일치
    expect(cronExpressionMatchesDate('30 9 7 * 0', monday)).toBe(false);
  });

  it('returns false for invalid expressions', () => {
    expect(cronExpressionMatchesDate('not cron', monday)).toBe(false);
  });
});
