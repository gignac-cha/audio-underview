import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  getSchedulerRun,
  listSchedulerRuns,
} from '@audio-underview/supabase-connector';
import type { Environment } from '../index.ts';
import { verifySchedulerOwnership } from './tools.ts';

export async function handleListRuns(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  const url = new URL(request.url);
  const offsetParameter = url.searchParams.get('offset');
  const limitParameter = url.searchParams.get('limit');

  let offset: number | undefined;
  let limit: number | undefined;

  if (offsetParameter !== null && offsetParameter.trim() !== '') {
    offset = Number(offsetParameter);
    if (!Number.isInteger(offset) || offset < 0) {
      return errorResponse('invalid_request', "Parameter 'offset' must be a non-negative integer", 400, context);
    }
  }

  if (limitParameter !== null && limitParameter.trim() !== '') {
    limit = Number(limitParameter);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorResponse('invalid_request', "Parameter 'limit' must be an integer between 1 and 100", 400, context);
    }
  }

  const result = await listSchedulerRuns(supabaseClient, schedulerID, { offset, limit });
  return jsonResponse({
    data: result.data,
    total: result.total,
    offset: offset ?? 0,
    limit: limit ?? 20,
  }, 200, context);
}

export async function handleGetRun(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  runID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  const run = await getSchedulerRun(supabaseClient, runID, schedulerID);
  if (!run) {
    return errorResponse('not_found', 'Run not found', 404, context);
  }

  return jsonResponse(run, 200, context);
}
