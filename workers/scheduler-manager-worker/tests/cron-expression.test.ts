import { describe, it, expect, vi } from 'vitest';
import { findNextOccurrence, parseCronExpression } from '../sources/cron-expression.ts';
import { isValidCronExpression } from '../sources/handlers/tools.ts';

function sorted(values: ReadonlySet<number> | undefined): number[] {
  return [...(values ?? [])].sort((left, right) => left - right);
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

// Values around every field's bounds, with leading zeros and signs as near misses.
const FIELD_NUMBERS = ['0', '1', '2', '5', '6', '7', '8', '9', '10', '12', '13', '23', '24', '29', '30', '31', '32', '59', '60', '99', '100', '00', '01', '05', '007', '-1'];
const FIELD_STEPS = ['0', '1', '2', '7', '10', '60', '100', '00', '01', ''];
const FIELD_LIST_ITEMS = ['0', '1', '7', '12', '24', '31', '60', '1-5', '5-1', '0-7', '1-31', '0-59', '01-5', '*', '*/2', '1/2', 'MON', ''];
const FIELD_OTHERS = [
  'MON', 'mon', 'JAN', '?', 'L', 'W', '1W', '5L', '1#2', 'L-1', '1-5/2', '*/2/3', '1--2', '1-2-3',
  '-', '/', ',', '**', '*1', '1*', '+1', '1.0', '1e1', '0x1', '１', '٣',
];

// Every form of the grammar (`*`, `*/s`, `n`, `n/s`, `n-m`, lists) and its near misses.
function generateFields(): string[] {
  const fields = new Set<string>(['*', ...FIELD_OTHERS]);
  for (const step of FIELD_STEPS) {
    fields.add(`*/${step}`);
  }
  for (const number of FIELD_NUMBERS) {
    fields.add(number);
    for (const step of FIELD_STEPS) {
      fields.add(`${number}/${step}`);
    }
    for (const end of FIELD_NUMBERS) {
      fields.add(`${number}-${end}`);
    }
  }
  for (const first of FIELD_LIST_ITEMS) {
    for (const second of FIELD_LIST_ITEMS) {
      fields.add(`${first},${second}`);
      fields.add(`${first},${second},${first}`);
    }
  }
  return [...fields];
}

// A seeded generator (mulberry32), so a failing combination is the same on every run.
function createRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function countLocalTimeReads(search: () => Date | null): { result: Date | null; reads: number } {
  const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
  try {
    const result = search();
    return { result, reads: formatToParts.mock.calls.length };
  } finally {
    formatToParts.mockRestore();
  }
}

describe('cron-expression', () => {
  describe('parseCronExpression', () => {
    it('reads */s as every s from the start of the range', () => {
      const schedule = parseCronExpression('*/20 * * * *');

      expect(sorted(schedule?.minutes)).toEqual([0, 20, 40]);
    });

    it('reads n/s as every s from n to the end of the range', () => {
      const schedule = parseCronExpression('5/10 * * * *');

      expect(sorted(schedule?.minutes)).toEqual([5, 15, 25, 35, 45, 55]);
    });

    it('reads a list of values and ranges', () => {
      const schedule = parseCronExpression('1-5,10 * * * *');

      expect(sorted(schedule?.minutes)).toEqual([1, 2, 3, 4, 5, 10]);
    });

    it('reads day of week 7 as Sunday', () => {
      const schedule = parseCronExpression('0 9 * * 7');

      expect(sorted(schedule?.daysOfWeek)).toEqual([0]);
    });

    it('reads * as the whole range', () => {
      const schedule = parseCronExpression('0 * * * *');

      expect(sorted(schedule?.hours)).toEqual(range(0, 23));
    });

    it.each([
      { label: '*', expression: '0 9 * * *' },
      { label: '*/2', expression: '0 9 */2 * */2' },
    ])('marks day fields that start with $label as starred', ({ expression }) => {
      const schedule = parseCronExpression(expression);

      expect(schedule?.dayOfMonthStarred).toBe(true);
      expect(schedule?.dayOfWeekStarred).toBe(true);
    });

    it.each([
      { label: '6', expression: '0 9 6 * 6' },
      { label: '1-5', expression: '0 9 1-5 * 1-5' },
    ])('does not mark day fields like $label as starred', ({ expression }) => {
      const schedule = parseCronExpression(expression);

      expect(schedule?.dayOfMonthStarred).toBe(false);
      expect(schedule?.dayOfWeekStarred).toBe(false);
    });

    it.each([
      { label: '60 * * * *', expression: '60 * * * *' },
      { label: '* 24 * * *', expression: '* 24 * * *' },
      { label: '* * 0 * *', expression: '* * 0 * *' },
      { label: '* * * 13 *', expression: '* * * 13 *' },
      { label: '* * * * 8', expression: '* * * * 8' },
      { label: '5-1 * * * *', expression: '5-1 * * * *' },
      { label: '*/0 * * * *', expression: '*/0 * * * *' },
      { label: '1-5/2 * * * *', expression: '1-5/2 * * * *' },
      { label: '0 9 * * MON', expression: '0 9 * * MON' },
      { label: 'four fields', expression: '0 9 * *' },
      { label: 'six fields', expression: '0 0 9 * * *' },
      { label: 'the empty string', expression: '' },
    ])('returns null for $label', ({ expression }) => {
      expect(parseCronExpression(expression)).toBeNull();
    });
  });

  describe('grammar parity with isValidCronExpression', () => {
    const fields = generateFields();

    function findMismatches(expressions: readonly string[]) {
      return expressions
        .map((expression) => ({
          expression,
          parsed: parseCronExpression(expression) !== null,
          validated: isValidCronExpression(expression),
        }))
        .filter(({ parsed, validated }) => parsed !== validated);
    }

    it.each([
      { position: 0, label: 'minute' },
      { position: 1, label: 'hour' },
      { position: 2, label: 'day of month' },
      { position: 3, label: 'month' },
      { position: 4, label: 'day of week' },
    ])('accepts the same $label fields', ({ position }) => {
      const expressions = [['*', '*', '*', '*', '*'], ['0', '9', '1', '1', '1']].flatMap((baseline) => fields.map((field) => {
        const expressionFields = [...baseline];
        expressionFields[position] = field;
        return expressionFields.join(' ');
      }));

      const acceptedCount = expressions.filter((expression) => isValidCronExpression(expression)).length;

      expect(findMismatches(expressions)).toEqual([]);
      expect(acceptedCount).toBeGreaterThan(0);
      expect(acceptedCount).toBeLessThan(expressions.length);
    });

    it('accepts the same combinations of fields', () => {
      const random = createRandom(20261005);
      const expressions = Array.from({ length: 5000 }, () => (
        Array.from({ length: 5 }, () => fields[Math.floor(random() * fields.length)]).join(' ')
      ));

      expect(findMismatches(expressions)).toEqual([]);
    });

    it('accepts the same field counts and whitespace', () => {
      const expressions = [
        '',
        ' ',
        '0 9 * *',
        '0 9 * * * *',
        '0 0 9 * * *',
        '  0 9 * * *  ',
        '0\t9\t*\t*\t*',
        '0\n9 * * *',
        '0  9 * * *',
        '0 9 * * *',
        '0 9 * * *\n',
      ];

      expect(findMismatches(expressions)).toEqual([]);
    });
  });

  describe('findNextOccurrence search cost', () => {
    // Counted, not timed, so the test does not depend on the machine.
    it.each([
      { cron: '0 9 1 * *', expected: '2026-11-01T00:00:00.000Z', maximumReads: 200 },
      { cron: '0 0 29 2 *', expected: '2028-02-28T15:00:00.000Z', maximumReads: 1000 },
      { cron: '0 0 31 2 *', expected: null, maximumReads: 10000 },
      { cron: '0 0 31 2,4,6,9,11 *', expected: null, maximumReads: 10000 },
    ])('reads the local time at most $maximumReads times for $cron', ({ cron, expected, maximumReads }) => {
      const schedule = parseCronExpression(cron);
      if (schedule === null) throw new Error(`Cannot parse ${cron}`);

      const { result, reads } = countLocalTimeReads(() => findNextOccurrence(schedule, 'Asia/Seoul', new Date('2026-10-05T00:00:00.000Z')));

      expect(result?.toISOString() ?? null).toBe(expected);
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(maximumReads);
    });
  });
});
