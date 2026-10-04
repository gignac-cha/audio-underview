// Same rule as the scheduler manager worker: the cron trigger fires every 10 minutes,
// so the minute field may only name 10-minute values.
const ALLOWED_MINUTE_PATTERN = /^(\*\/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$/;

export function isScheduleMinuteAllowed(cronExpression: string): boolean {
  const [minute] = cronExpression.trim().split(/\s+/);
  return ALLOWED_MINUTE_PATTERN.test(minute);
}
