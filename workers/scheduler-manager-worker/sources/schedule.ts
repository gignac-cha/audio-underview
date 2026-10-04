import type { SchedulerRow, SchedulerRunRow } from '@audio-underview/supabase-connector';
import { findNextOccurrence, parseCronExpression } from './cron-expression.ts';

export const DEFAULT_TIMEZONE = 'Asia/Seoul';

// The tick runs every 10 minutes, so only minutes it can hit exactly are accepted.
const SCHEDULE_MINUTE_PATTERN = /^(\*\/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
// A `longOffset` time zone name: `GMT+05:45`, `GMT-03:30`, or plain `GMT` for a zero offset.
const LONG_OFFSET_PATTERN = /^GMT(?:([+-])(\d{1,2}):(\d{2}))?$/;

/**
 * Whether the minute field of a cron expression falls on the 10-minute tick.
 */
export function isScheduleMinuteAllowed(cronExpression: string): boolean {
  const [minute] = cronExpression.trim().split(/\s+/);
  return SCHEDULE_MINUTE_PATTERN.test(minute);
}

/**
 * Whether the value is an IANA time zone the runtime knows.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!TIMEZONE_PATTERN.test(timezone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC offset of the time zone at `date` in minutes, or null when the runtime gives a value it cannot read.
 */
function readUTCOffsetMinutes(timezone: string, date: Date): number | null {
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = LONG_OFFSET_PATTERN.exec(offsetName ?? '');
  if (match === null) return null;
  if (match[1] === undefined) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Whether the time zone can be stored for a schedule: a valid time zone whose UTC offset is a
 * multiple of 10 minutes at 12:00 UTC on both January 1 and July 1 of `at`'s UTC year. Otherwise
 * local whole hours fall between 10-minute ticks, and `0 9 * * *` would run late.
 */
export function isScheduleTimezoneAllowed(timezone: string, at: Date): boolean {
  if (!isValidTimezone(timezone)) return false;
  const year = at.getUTCFullYear();
  return [Date.UTC(year, 0, 1, 12), Date.UTC(year, 6, 1, 12)].every((time) => {
    const offsetMinutes = readUTCOffsetMinutes(timezone, new Date(time));
    return offsetMinutes !== null && offsetMinutes % 10 === 0;
  });
}

/**
 * The first occurrence strictly after `after`, evaluated in `timezone`.
 * Never throws.
 *
 * @returns null when there is no further occurrence, or the expression or time zone cannot be parsed
 */
export function computeNextRunAt(cronExpression: string, timezone: string, after: Date): Date | null {
  if (!isValidTimezone(timezone)) return null;
  try {
    const schedule = parseCronExpression(cronExpression);
    return schedule === null ? null : findNextOccurrence(schedule, timezone, after);
  } catch {
    return null;
  }
}

/**
 * The next_run_at value to store for a scheduler.
 *
 * @returns null when the scheduler is disabled, has no cron expression, or has no further occurrence
 */
export function resolveNextRunAt(
  scheduler: Pick<SchedulerRow, 'cron_expression' | 'timezone' | 'is_enabled'>,
  after: Date,
): string | null {
  if (!scheduler.is_enabled || scheduler.cron_expression === null) return null;
  return computeNextRunAt(scheduler.cron_expression, scheduler.timezone, after)?.toISOString() ?? null;
}

/**
 * Workflow instance ID of one scheduled occurrence: the scheduler ID and the occurrence in epoch minutes.
 */
export function schedulerRunInstanceID(schedulerID: string, scheduledFor: Date): string {
  return `${schedulerID}-${Math.floor(scheduledFor.getTime() / 60000)}`;
}

/**
 * Workflow instance ID of a manual run that has a task group stage.
 */
export function manualRunInstanceID(runID: string): string {
  return `manual-${runID}`;
}

/**
 * Workflow instance ID of any run: the occurrence's ID for a scheduled run, the manual one otherwise.
 * A manual run executed inside its request has no instance under this ID.
 */
export function runInstanceID(run: Pick<SchedulerRunRow, 'id' | 'scheduler_id' | 'triggered_by' | 'scheduled_for'>): string {
  if (run.triggered_by === 'schedule' && run.scheduled_for !== null) {
    return schedulerRunInstanceID(run.scheduler_id, new Date(run.scheduled_for));
  }
  return manualRunInstanceID(run.id);
}
