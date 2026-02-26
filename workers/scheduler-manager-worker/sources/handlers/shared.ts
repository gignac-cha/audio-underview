import {
  type ResponseContext,
  errorResponse,
} from '@audio-underview/worker-tools';
import { getScheduler } from '@audio-underview/supabase-connector';
import type { SupabaseClient } from '@audio-underview/supabase-connector';

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
