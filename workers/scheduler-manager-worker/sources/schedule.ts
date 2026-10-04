import type { SchedulerRow } from '@audio-underview/supabase-connector';
import { findNextOccurrence, parseCronExpression } from './cron-expression.ts';

export const DEFAULT_TIMEZONE = 'Asia/Seoul';

// The tick runs every 10 minutes, so only minutes it can hit exactly are accepted.
const SCHEDULE_MINUTE_PATTERN = /^(\*\/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$/;
const TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;

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
