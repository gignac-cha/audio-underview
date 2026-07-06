/**
 * 표준 5필드 cron 표현식 검증: `분 시 일 월 요일`.
 *
 * 각 필드는 `,` 리스트로 구성되고, 항목은 `*` | `*​/step` | `값` | `값-범위` |
 * `값/step` | `값-범위/step`을 허용한다. 범위는 start ≤ end 여야 한다.
 * (레거시 `CRON_FIELD_PATTERNS`와 동일 acceptance — 스펙 §4.2)
 */

interface CronFieldBounds {
  readonly minimum: number;
  readonly maximum: number;
}

const CRON_FIELD_BOUNDS: readonly CronFieldBounds[] = [
  { minimum: 0, maximum: 59 }, // 분
  { minimum: 0, maximum: 23 }, // 시
  { minimum: 1, maximum: 31 }, // 일
  { minimum: 1, maximum: 12 }, // 월
  { minimum: 0, maximum: 7 }, // 요일 (0과 7 모두 일요일)
];

const CRON_ITEM_PATTERN = /^(\*|\d+(-\d+)?)(\/\d+)?$/;

const isValidCronItem = (item: string, bounds: CronFieldBounds): boolean => {
  const match = CRON_ITEM_PATTERN.exec(item);
  if (match === null) {
    return false;
  }

  const [, base, rangePart, stepPart] = match;

  if (stepPart !== undefined) {
    const step = Number(stepPart.slice(1));
    if (step < 1) {
      return false;
    }
  }

  if (base === '*' || base === undefined) {
    return base === '*';
  }

  const [startText, endText] = base.split('-');
  const start = Number(startText);
  if (start < bounds.minimum || start > bounds.maximum) {
    return false;
  }

  if (rangePart !== undefined && endText !== undefined) {
    const end = Number(endText);
    if (end < bounds.minimum || end > bounds.maximum || start > end) {
      return false;
    }
  }

  return true;
};

export const isValidCronExpression = (expression: string): boolean => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_BOUNDS.length) {
    return false;
  }

  return fields.every((field, index) => {
    const bounds = CRON_FIELD_BOUNDS[index];
    if (bounds === undefined || field.length === 0) {
      return false;
    }
    return field.split(',').every((item) => isValidCronItem(item, bounds));
  });
};
