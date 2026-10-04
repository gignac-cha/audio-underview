export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>; // 0 = Sunday … 6 = Saturday
  dayOfMonthStarred: boolean;
  dayOfWeekStarred: boolean;
}

interface FieldRange {
  minimum: number;
  maximum: number;
}

// minute, hour, day of month, month, day of week (7 is Sunday as well as 0)
const FIELD_RANGES: readonly FieldRange[] = [
  { minimum: 0, maximum: 59 },
  { minimum: 0, maximum: 23 },
  { minimum: 1, maximum: 31 },
  { minimum: 1, maximum: 12 },
  { minimum: 0, maximum: 7 },
];

// The same field grammar isValidCronExpression in handlers/tools.ts accepts: `*`, `*/s`, `n/s`,
// or a comma list of `n` and `n-m`. Numbers have no leading zero and a step is at least 1.
const STEP_FIELD_PATTERN = /^(\*|0|[1-9]\d*)\/([1-9]\d*)$/;
const LIST_SEGMENT_PATTERN = /^(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/;

const MINUTE_IN_MILLISECONDS = 60_000;
const MINUTES_IN_DAY = 1440;
const SEARCH_HORIZON_IN_YEARS = 9;
const MAXIMUM_SEARCH_ITERATIONS = 100_000;

// Stepping 120 minutes short of the local midnight keeps a 22- or 23-hour daylight-saving day
// (Antarctica/Troll shifts by 2 hours) from skipping past the early hours of the next local day.
const SKIP_MARGIN_IN_MINUTES = 120;

// A wall-clock minute that was also the local time this many minutes earlier occurs a second
// time because clocks went back (by 30 minutes, 1 hour or 2 hours).
const REPEATED_TIME_OFFSETS_IN_MINUTES: readonly number[] = [30, 60, 120];

const WEEKDAY_NUMBERS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function stepValues(start: number, end: number, step: number): Set<number> {
  const values = new Set<number>();
  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
  return values;
}

function parseField(field: string, range: FieldRange): Set<number> | null {
  if (field === '*') {
    return stepValues(range.minimum, range.maximum, 1);
  }

  const stepMatch = STEP_FIELD_PATTERN.exec(field);
  if (stepMatch !== null) {
    const start = stepMatch[1] === '*' ? range.minimum : Number(stepMatch[1]);
    if (start < range.minimum || start > range.maximum) return null;
    return stepValues(start, range.maximum, Number(stepMatch[2]));
  }

  const values = new Set<number>();
  for (const segment of field.split(',')) {
    const segmentMatch = LIST_SEGMENT_PATTERN.exec(segment);
    if (segmentMatch === null) return null;
    const start = Number(segmentMatch[1]);
    const end = segmentMatch[2] === undefined ? start : Number(segmentMatch[2]);
    if (start < range.minimum || end > range.maximum || start > end) return null;
    for (let value = start; value <= end; value += 1) {
      values.add(value);
    }
  }
  return values;
}

/**
 * Parses a 5-field cron expression: minute, hour, day of month, month, day of week.
 * Never throws.
 *
 * @returns null when the expression is not in the grammar the save validation accepts
 */
export function parseCronExpression(expression: string): CronSchedule | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELD_RANGES.length) return null;

  const sets: Set<number>[] = [];
  for (const [index, field] of fields.entries()) {
    const values = parseField(field, FIELD_RANGES[index]);
    if (values === null) return null;
    sets.push(values);
  }

  const [minutes, hours, daysOfMonth, months, daysOfWeek] = sets;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...daysOfWeek].map((value) => (value === 7 ? 0 : value))),
    dayOfMonthStarred: fields[2].startsWith('*'),
    dayOfWeekStarred: fields[4].startsWith('*'),
  };
}

function readLocalTime(formatter: Intl.DateTimeFormat, time: number): LocalTime {
  const localTime: LocalTime = { year: 0, month: 0, day: 0, hour: 0, minute: 0, weekday: 0 };
  for (const part of formatter.formatToParts(time)) {
    switch (part.type) {
      case 'year':
        localTime.year = Number(part.value);
        break;
      case 'month':
        localTime.month = Number(part.value);
        break;
      case 'day':
        localTime.day = Number(part.value);
        break;
      case 'hour':
        localTime.hour = Number(part.value);
        break;
      case 'minute':
        localTime.minute = Number(part.value);
        break;
      case 'weekday':
        localTime.weekday = WEEKDAY_NUMBERS[part.value];
        break;
    }
  }
  return localTime;
}

// Reads local times, remembering the last one: a jump to the next local hour reads where it lands,
// and the next search iteration starts there without reading it again.
function createLocalTimeReader(formatter: Intl.DateTimeFormat): (time: number) => LocalTime {
  let lastTime: number | undefined;
  let lastLocalTime: LocalTime | undefined;
  return (time) => {
    if (lastLocalTime === undefined || lastTime !== time) {
      lastLocalTime = readLocalTime(formatter, time);
      lastTime = time;
    }
    return lastLocalTime;
  };
}

// The local date and time counted in minutes as if it were UTC. Unlike the real time, it moves
// with the local clock, so it shows when a jump crossed a clock change.
function wallClockMinutes(localTime: LocalTime): number {
  return Date.UTC(localTime.year, localTime.month - 1, localTime.day, localTime.hour, localTime.minute) / MINUTE_IN_MILLISECONDS;
}

/**
 * The first real minute after `time` whose local time is at or past the start of the next local hour.
 * Jumping `60 - localMinute` minutes lands there unless clocks went forward inside the jump. When the
 * change is not on the hour (Pacific/Chatham goes from 02:45 to 03:45), the jump would also pass local
 * times that exist (03:45 to 03:59), so the first minute after the change is found by bisection.
 * Clocks going back only repeat local times, which run the first time only, so that landing stays.
 */
function findNextLocalHourTime(localTimeAt: (time: number) => LocalTime, time: number, localTime: LocalTime): number {
  const nextLocalHour = wallClockMinutes(localTime) + 60 - localTime.minute;
  const landingTime = time + (60 - localTime.minute) * MINUTE_IN_MILLISECONDS;
  if (wallClockMinutes(localTimeAt(landingTime)) <= nextLocalHour) return landingTime;

  // The local time at `earlierTime` is still before the next local hour, at `laterTime` at or past it.
  let earlierTime = time;
  let laterTime = landingTime;
  while (laterTime - earlierTime > MINUTE_IN_MILLISECONDS) {
    const middleTime = earlierTime + Math.floor((laterTime - earlierTime) / (2 * MINUTE_IN_MILLISECONDS)) * MINUTE_IN_MILLISECONDS;
    if (wallClockMinutes(localTimeAt(middleTime)) < nextLocalHour) {
      earlierTime = middleTime;
    } else {
      laterTime = middleTime;
    }
  }
  return laterTime;
}

function isSameWallClockMinute(left: LocalTime, right: LocalTime): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

// Standard (Vixie) cron: when either day field starts with `*`, both must match; otherwise either may.
function isDayMatched(schedule: CronSchedule, localTime: LocalTime): boolean {
  const dayOfMonthMatched = schedule.daysOfMonth.has(localTime.day);
  const dayOfWeekMatched = schedule.daysOfWeek.has(localTime.weekday);
  if (schedule.dayOfMonthStarred || schedule.dayOfWeekStarred) {
    return dayOfMonthMatched && dayOfWeekMatched;
  }
  return dayOfMonthMatched || dayOfWeekMatched;
}

/**
 * The first occurrence of the schedule strictly after `after`, evaluated in `timezone`.
 * A local time skipped by a daylight-saving change does not occur that day, and a local time
 * repeated by one occurs only the first time.
 *
 * @param timezone an IANA time zone the runtime knows
 * @returns null when there is no occurrence within 9 years
 */
export function findNextOccurrence(schedule: CronSchedule, timezone: string, after: Date): Date | null {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  });

  const horizon = new Date(after.getTime());
  horizon.setUTCFullYear(horizon.getUTCFullYear() + SEARCH_HORIZON_IN_YEARS);

  const localTimeAt = createLocalTimeReader(formatter);

  const sortedMinutes = [...schedule.minutes].sort((left, right) => left - right);

  let time = Math.floor(after.getTime() / MINUTE_IN_MILLISECONDS) * MINUTE_IN_MILLISECONDS + MINUTE_IN_MILLISECONDS;

  for (let iteration = 0; iteration < MAXIMUM_SEARCH_ITERATIONS; iteration += 1) {
    if (time > horizon.getTime()) return null;

    const localTime = localTimeAt(time);
    const minutesToLocalMidnight = MINUTES_IN_DAY - (localTime.hour * 60 + localTime.minute);

    // Within the margin before the local midnight, a skip would be smaller than a minute: the
    // last stretch of the day is covered by jumps to the next local hour instead.
    if (!schedule.months.has(localTime.month)) {
      const daysInLocalMonth = new Date(Date.UTC(localTime.year, localTime.month, 0)).getUTCDate();
      const minutesToSkip = minutesToLocalMidnight + (daysInLocalMonth - localTime.day) * MINUTES_IN_DAY - SKIP_MARGIN_IN_MINUTES;
      time = minutesToSkip >= 1 ? time + minutesToSkip * MINUTE_IN_MILLISECONDS : findNextLocalHourTime(localTimeAt, time, localTime);
      continue;
    }

    if (!isDayMatched(schedule, localTime)) {
      const minutesToSkip = minutesToLocalMidnight - SKIP_MARGIN_IN_MINUTES;
      time = minutesToSkip >= 1 ? time + minutesToSkip * MINUTE_IN_MILLISECONDS : findNextLocalHourTime(localTimeAt, time, localTime);
      continue;
    }

    if (!schedule.hours.has(localTime.hour)) {
      time = findNextLocalHourTime(localTimeAt, time, localTime);
      continue;
    }

    if (!schedule.minutes.has(localTime.minute)) {
      const nextAllowedMinute = sortedMinutes.find((minute) => minute > localTime.minute);
      time = nextAllowedMinute === undefined
        ? findNextLocalHourTime(localTimeAt, time, localTime)
        : time + (nextAllowedMinute - localTime.minute) * MINUTE_IN_MILLISECONDS;
      continue;
    }

    // Clocks went back: this wall-clock minute already occurred 30, 60 or 120 minutes earlier.
    const repeated = REPEATED_TIME_OFFSETS_IN_MINUTES.some((minutesBefore) => isSameWallClockMinute(
      readLocalTime(formatter, time - minutesBefore * MINUTE_IN_MILLISECONDS),
      localTime,
    ));
    if (repeated) {
      time += MINUTE_IN_MILLISECONDS;
      continue;
    }

    return new Date(time);
  }

  return null;
}
