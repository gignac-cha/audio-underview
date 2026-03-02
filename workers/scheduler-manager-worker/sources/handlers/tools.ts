import {
  type ResponseContext,
  errorResponse,
} from '@audio-underview/worker-tools';
import { getScheduler } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validates standard 5-field cron: minute(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-7)
const CRON_FIELD_PATTERNS = [
  /^(\*(\/[1-9]\d*)?|(\d|[1-5]\d)(\/[1-9]\d*)?|(\d|[1-5]\d)(-(\d|[1-5]\d))?(,(\d|[1-5]\d)(-(\d|[1-5]\d))?)*)$/,
  /^(\*(\/[1-9]\d*)?|(\d|1\d|2[0-3])(\/[1-9]\d*)?|(\d|1\d|2[0-3])(-(\d|1\d|2[0-3]))?(,(\d|1\d|2[0-3])(-(\d|1\d|2[0-3]))?)*)$/,
  /^(\*(\/[1-9]\d*)?|([1-9]|[12]\d|3[01])(\/[1-9]\d*)?|([1-9]|[12]\d|3[01])(-([1-9]|[12]\d|3[01]))?(,([1-9]|[12]\d|3[01])(-([1-9]|[12]\d|3[01]))?)*)$/,
  /^(\*(\/[1-9]\d*)?|([1-9]|1[0-2])(\/[1-9]\d*)?|([1-9]|1[0-2])(-([1-9]|1[0-2]))?(,([1-9]|1[0-2])(-([1-9]|1[0-2]))?)*)$/,
  /^(\*(\/[1-9]\d*)?|[0-7](\/[1-9]\d*)?|[0-7](-[0-7])?(,[0-7](-[0-7])?)*)$/,
];

function hasValidRangeOrder(field: string): boolean {
  return field.split(',').every((segment) => {
    const [base] = segment.split('/');
    if (!base.includes('-')) return true;
    const [startText, endText] = base.split('-');
    const start = Number(startText);
    const end = Number(endText);
    return Number.isInteger(start) && Number.isInteger(end) && start <= end;
  });
}

export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => CRON_FIELD_PATTERNS[index].test(field) && hasValidRangeOrder(field));
}

export async function verifySchedulerOwnership(
  client: SupabaseClient,
  schedulerID: string,
  userUUID: string,
  context: ResponseContext,
): Promise<Response | null> {
  const scheduler = await getScheduler(client, schedulerID, userUUID);
  if (!scheduler) {
    return errorResponse('not_found', 'Scheduler not found', 404, context);
  }
  return null;
}
