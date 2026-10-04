// Same rule as the scheduler manager worker: the cron trigger fires every 10 minutes,
// so a time zone whose UTC offset is off the 10-minute grid would run local whole hours late.
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
// A `longOffset` time zone name: `GMT+05:45`, `GMT-03:30`, or plain `GMT` for a zero offset.
const LONG_OFFSET_PATTERN = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/;
const FALLBACK_TIMEZONE = 'UTC';

/**
 * The UTC offset of the formatter's time zone at `date`, in minutes.
 *
 * @returns null when the browser gives a value it cannot read
 */
function readUTCOffsetMinutes(formatter: Intl.DateTimeFormat, date: Date): number | null {
  const offsetName = formatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
  const match = LONG_OFFSET_PATTERN.exec(offsetName ?? '');
  if (match === null) return null;
  const [, sign, hours, minutes] = match;
  if (sign === undefined) return 0;
  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Whether schedules may use this time zone: it is an IANA time zone the browser knows, and
 * its UTC offset is a whole multiple of 10 minutes at 12:00 UTC on both January 1 and July 1
 * of the UTC year of `at`.
 */
export function isScheduleTimezoneAllowed(timezone: string, at: Date): boolean {
  if (!TIMEZONE_PATTERN.test(timezone)) return false;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  } catch {
    return false;
  }

  const year = at.getUTCFullYear();
  const samples = [new Date(Date.UTC(year, 0, 1, 12)), new Date(Date.UTC(year, 6, 1, 12))];
  return samples.every((sample) => {
    const offsetMinutes = readUTCOffsetMinutes(formatter, sample);
    return offsetMinutes !== null && offsetMinutes % 10 === 0;
  });
}

/**
 * Every time zone a schedule may use at `at`, sorted.
 */
export function listScheduleTimezones(at: Date): string[] {
  const timezones = new Set([...Intl.supportedValuesOf('timeZone'), FALLBACK_TIMEZONE]);
  return [...timezones].filter((timezone) => isScheduleTimezoneAllowed(timezone, at)).sort();
}

/**
 * The time zone of the viewer's browser.
 */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? FALLBACK_TIMEZONE;
}

/**
 * The time zone a new schedule starts with: the browser's when schedules may use it, otherwise UTC.
 */
export function defaultScheduleTimezone(at: Date): string {
  const timezone = browserTimezone();
  return isScheduleTimezoneAllowed(timezone, at) ? timezone : FALLBACK_TIMEZONE;
}

/**
 * The date and time of `isoString` as the wall clock in `timezone` shows it.
 */
export function formatInTimezone(isoString: string, timezone: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  });
}
