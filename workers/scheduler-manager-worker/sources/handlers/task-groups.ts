import {
  type ResponseContext,
  jsonResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  listTaskGroups,
} from '@audio-underview/supabase-connector';
import type { Environment } from '../index.ts';

/**
 * Lists every registered task group version with its formats. The binding of the group's
 * worker is internal to the scheduler and is left out.
 */
export async function handleListTaskGroups(
  environment: Environment,
  context: ResponseContext,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const taskGroups = await listTaskGroups(supabaseClient);
  return jsonResponse({
    data: taskGroups.map((taskGroup) => ({
      id: taskGroup.id,
      version: taskGroup.version,
      input_schema: taskGroup.input_schema,
      settings_schema: taskGroup.settings_schema,
      output_schema: taskGroup.output_schema,
      created_at: taskGroup.created_at,
    })),
  }, 200, context);
}
