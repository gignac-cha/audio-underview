import { describe, expect, it } from 'vitest';
import { isValidCronExpression } from '../sources/schedulers/cron.ts';

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
