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

const itemMatchesValue = (item: string, value: number, bounds: CronFieldBounds): boolean => {
  const match = CRON_ITEM_PATTERN.exec(item);
  if (match === null) {
    return false;
  }
  const [, base, rangePart, stepPart] = match;
  const step = stepPart === undefined ? 1 : Number(stepPart.slice(1));

  let start: number;
  let end: number;
  if (base === '*' || base === undefined) {
    start = bounds.minimum;
    end = bounds.maximum;
  } else {
    const [startText, endText] = base.split('-');
    start = Number(startText);
    end = rangePart !== undefined && endText !== undefined ? Number(endText) : start;
    // step이 있는 단일 값(`값/step`)은 값부터 최대치까지의 범위로 해석 (표준 cron)
    if (rangePart === undefined && stepPart !== undefined) {
      end = bounds.maximum;
    }
  }

  return value >= start && value <= end && (value - start) % step === 0;
};

const fieldMatchesValue = (field: string, value: number, bounds: CronFieldBounds): boolean =>
  field.split(',').some((item) => itemMatchesValue(item, value, bounds));

/**
 * cron 표현식이 주어진 시각(UTC)과 일치하는지 — scheduled handler의 분 단위 tick 매칭.
 * 표준 cron 규칙: 일(day-of-month)과 요일(day-of-week)이 **둘 다 제한**되면 OR로 결합.
 * 요일 7은 0(일요일)으로 정규화.
 */
export const cronExpressionMatchesDate = (expression: string, date: Date): boolean => {
  if (!isValidCronExpression(expression)) {
    return false;
  }
  const fields = expression.trim().split(/\s+/) as [string, string, string, string, string];
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = fields;

  const minuteBounds = { minimum: 0, maximum: 59 };
  const hourBounds = { minimum: 0, maximum: 23 };
  const dayOfMonthBounds = { minimum: 1, maximum: 31 };
  const monthBounds = { minimum: 1, maximum: 12 };
  const dayOfWeekBounds = { minimum: 0, maximum: 7 };

  if (!fieldMatchesValue(minuteField, date.getUTCMinutes(), minuteBounds)) {
    return false;
  }
  if (!fieldMatchesValue(hourField, date.getUTCHours(), hourBounds)) {
    return false;
  }
  if (!fieldMatchesValue(monthField, date.getUTCMonth() + 1, monthBounds)) {
    return false;
  }

  const dayOfWeek = date.getUTCDay(); // 0 = 일요일
  const dayOfWeekMatches =
    fieldMatchesValue(dayOfWeekField, dayOfWeek, dayOfWeekBounds) ||
    (dayOfWeek === 0 && fieldMatchesValue(dayOfWeekField, 7, dayOfWeekBounds));
  const dayOfMonthMatches = fieldMatchesValue(
    dayOfMonthField,
    date.getUTCDate(),
    dayOfMonthBounds,
  );

  // 표준 cron: 둘 다 '*'가 아니면 OR, 아니면 AND
  const dayOfMonthRestricted = dayOfMonthField !== '*';
  const dayOfWeekRestricted = dayOfWeekField !== '*';
  if (dayOfMonthRestricted && dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  return dayOfMonthMatches && dayOfWeekMatches;
};
