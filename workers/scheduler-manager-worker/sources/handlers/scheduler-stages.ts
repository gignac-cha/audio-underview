import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createSchedulerStage,
  listSchedulerStages,
  getSchedulerStage,
  updateSchedulerStage,
  deleteSchedulerStage,
  reorderSchedulerStages,
} from '@audio-underview/supabase-connector';
import type { Environment } from '../index.ts';
import { verifySchedulerOwnership, UUID_PATTERN } from './tools.ts';

interface CreateStageRequestBody {
  crawler_id: string;
  stage_order: number;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string;
}

interface UpdateStageRequestBody {
  crawler_id?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleCreateStage(
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

  let body: CreateStageRequestBody;
  try {
    body = await request.json() as CreateStageRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (typeof body.crawler_id !== 'string' || !UUID_PATTERN.test(body.crawler_id)) {
    return errorResponse('invalid_request', "Field 'crawler_id' is required and must be a valid UUID", 400, context);
  }

  if (typeof body.stage_order !== 'number' || !Number.isInteger(body.stage_order) || body.stage_order < 0) {
    return errorResponse('invalid_request', "Field 'stage_order' is required and must be a non-negative integer", 400, context);
  }

  if (!isPlainObject(body.input_schema)) {
    return errorResponse('invalid_request', "Field 'input_schema' is required and must be a JSON object", 400, context);
  }

  if (body.output_schema !== undefined && !isPlainObject(body.output_schema)) {
    return errorResponse('invalid_request', "Field 'output_schema' must be a JSON object", 400, context);
  }

  if (body.fan_out_field !== undefined) {
    if (typeof body.fan_out_field !== 'string' || !body.fan_out_field.trim()) {
      return errorResponse('invalid_request', "Field 'fan_out_field' must be a non-empty string", 400, context);
    }
  }

  try {
    const stage = await createSchedulerStage(supabaseClient, {
      scheduler_id: schedulerID,
      crawler_id: body.crawler_id,
      stage_order: body.stage_order,
      input_schema: body.input_schema,
      output_schema: body.output_schema,
      fan_out_field: body.fan_out_field,
    });

    return jsonResponse(stage, 201, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('unique') || message.includes('UNIQUE') || message.includes('23505')) {
      return errorResponse('conflict', 'A stage with this order already exists', 409, context);
    }
    if (message.includes('RESTRICT') || message.includes('23503') || message.includes('violates foreign key')) {
      return errorResponse('invalid_request', 'Referenced crawler does not exist', 400, context);
    }
    throw error;
  }
}

export async function handleListStages(
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

  const stages = await listSchedulerStages(supabaseClient, schedulerID);
  return jsonResponse({ data: stages }, 200, context);
}

export async function handleGetStage(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  stageID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  const stage = await getSchedulerStage(supabaseClient, stageID, schedulerID);
  if (!stage) {
    return errorResponse('not_found', 'Stage not found', 404, context);
  }

  return jsonResponse(stage, 200, context);
}

export async function handleUpdateStage(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  stageID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  let body: UpdateStageRequestBody;
  try {
    body = await request.json() as UpdateStageRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (body.crawler_id !== undefined) {
    if (typeof body.crawler_id !== 'string' || !UUID_PATTERN.test(body.crawler_id)) {
      return errorResponse('invalid_request', "Field 'crawler_id' must be a valid UUID", 400, context);
    }
  }

  if (body.input_schema !== undefined && !isPlainObject(body.input_schema)) {
    return errorResponse('invalid_request', "Field 'input_schema' must be a JSON object", 400, context);
  }

  if (body.output_schema !== undefined && !isPlainObject(body.output_schema)) {
    return errorResponse('invalid_request', "Field 'output_schema' must be a JSON object", 400, context);
  }

  if (body.fan_out_field !== undefined && body.fan_out_field !== null) {
    if (typeof body.fan_out_field !== 'string' || !body.fan_out_field.trim()) {
      return errorResponse('invalid_request', "Field 'fan_out_field' must be a non-empty string or null", 400, context);
    }
  }

  if (body.crawler_id === undefined && body.input_schema === undefined && body.output_schema === undefined && body.fan_out_field === undefined) {
    return errorResponse('invalid_request', 'At least one field must be provided for update', 400, context);
  }

  const updatePayload: Record<string, unknown> = {};
  if (body.crawler_id !== undefined) updatePayload.crawler_id = body.crawler_id;
  if (body.input_schema !== undefined) updatePayload.input_schema = body.input_schema;
  if (body.output_schema !== undefined) updatePayload.output_schema = body.output_schema;
  if (body.fan_out_field !== undefined) updatePayload.fan_out_field = body.fan_out_field;

  try {
    const stage = await updateSchedulerStage(supabaseClient, stageID, schedulerID, updatePayload);

    if (!stage) {
      return errorResponse('not_found', 'Stage not found', 404, context);
    }

    return jsonResponse(stage, 200, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('RESTRICT') || message.includes('23503') || message.includes('violates foreign key')) {
      return errorResponse('invalid_request', 'Referenced crawler does not exist', 400, context);
    }
    if (message.includes('unique') || message.includes('UNIQUE') || message.includes('23505')) {
      return errorResponse('conflict', 'A stage with this configuration already exists', 409, context);
    }
    throw error;
  }
}

export async function handleDeleteStage(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  stageID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const ownershipError = await verifySchedulerOwnership(supabaseClient, schedulerID, userUUID, context);
  if (ownershipError) return ownershipError;

  const deleted = await deleteSchedulerStage(supabaseClient, stageID, schedulerID);
  if (!deleted) {
    return errorResponse('not_found', 'Stage not found', 404, context);
  }

  return jsonResponse({ deleted: true }, 200, context);
}

interface ReorderStagesRequestBody {
  stage_ids: string[];
}

export async function handleReorderStages(
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

  let body: ReorderStagesRequestBody;
  try {
    body = await request.json() as ReorderStagesRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (!Array.isArray(body.stage_ids) || body.stage_ids.length === 0) {
    return errorResponse('invalid_request', "Field 'stage_ids' is required and must be a non-empty array of UUIDs", 400, context);
  }

  for (const stageID of body.stage_ids) {
    if (typeof stageID !== 'string' || !UUID_PATTERN.test(stageID)) {
      return errorResponse('invalid_request', "Each element in 'stage_ids' must be a valid UUID", 400, context);
    }
  }

  const uniqueIDs = new Set(body.stage_ids);
  if (uniqueIDs.size !== body.stage_ids.length) {
    return errorResponse('invalid_request', "Field 'stage_ids' must not contain duplicates", 400, context);
  }

  try {
    const stages = await reorderSchedulerStages(supabaseClient, schedulerID, body.stage_ids);
    return jsonResponse({ data: stages }, 200, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (
      message.includes('mismatch') ||
      message.includes('unknown') ||
      message.includes('not found') ||
      message.includes('validation') ||
      message.includes('23503') ||
      message.includes('violates')
    ) {
      return errorResponse('invalid_request', 'Stage reorder validation failed', 400, context);
    }
    throw error;
  }
}
