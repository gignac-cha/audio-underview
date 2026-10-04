import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  type SupabaseClient,
  type SchedulerStageRow,
  createSupabaseClient,
  getCrawlerPermission,
  createSchedulerStage,
  listSchedulerStages,
  getSchedulerStage,
  updateSchedulerStage,
  deleteSchedulerStage,
  reorderSchedulerStages,
  getTaskGroup,
} from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from '../index.ts';
import { UnsupportedSchemaError, validateAgainstSchema } from '../schema-validation.ts';
import { verifySchedulerOwnership, UUID_PATTERN } from './tools.ts';

type FanOutStrategy = 'compact' | 'preserve';

interface CreateStageRequestBody {
  stage_type?: 'crawler' | 'task_group';
  crawler_id: string;
  stage_order: number;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string;
  fan_out_strategy?: FanOutStrategy;
  task_group_id?: string;
  task_group_version?: number;
  settings?: Record<string, unknown>;
}

interface UpdateStageRequestBody {
  stage_type?: unknown;
  task_group_id?: unknown;
  crawler_id?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  fan_out_field?: string | null;
  fan_out_strategy?: FanOutStrategy;
  task_group_version?: number;
  settings?: Record<string, unknown>;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'scheduler-stages-handler',
  },
});

// Fields of a task group stage, in the order they are checked
const TASK_GROUP_STAGE_FIELDS = ['task_group_id', 'task_group_version', 'settings'] as const;
// Fields of a crawler stage a task group stage does not have, in the order they are checked
const CRAWLER_STAGE_FIELDS = ['crawler_id', 'input_schema', 'output_schema', 'fan_out_field', 'fan_out_strategy'] as const;

const TASK_GROUP_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAXIMUM_TASK_GROUP_ID_LENGTH = 63;
// task_groups.version is an INTEGER column, so no registered version is larger
const MAXIMUM_TASK_GROUP_VERSION = 2_147_483_647;
const STAGE_TYPE_CONSTRAINT = 'scheduler_stages_type_check';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskGroupID(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAXIMUM_TASK_GROUP_ID_LENGTH && TASK_GROUP_ID_PATTERN.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * The first of the fields present in the body, if any. A field is present unless it is undefined.
 */
function findPresentField(body: object, fields: readonly string[]): string | undefined {
  return fields.find((field) => (body as Record<string, unknown>)[field] !== undefined);
}

function notRegisteredDescription(taskGroupID: string, taskGroupVersion: number): string {
  return `Task group '${taskGroupID}' version ${taskGroupVersion} is not registered`;
}

/**
 * Checks settings against the settings format of a registered task group version.
 *
 * @returns an error response, or null when the settings are valid
 */
async function verifyTaskGroupSettings(
  supabaseClient: SupabaseClient,
  context: ResponseContext,
  taskGroupID: string,
  taskGroupVersion: number,
  settings: Record<string, unknown>,
): Promise<Response | null> {
  const taskGroup = taskGroupVersion > MAXIMUM_TASK_GROUP_VERSION
    ? undefined
    : await getTaskGroup(supabaseClient, taskGroupID, taskGroupVersion);
  if (taskGroup === undefined) {
    return errorResponse('invalid_request', notRegisteredDescription(taskGroupID, taskGroupVersion), 400, context);
  }

  let validation;
  try {
    validation = validateAgainstSchema(taskGroup.settings_schema, settings);
  } catch (error) {
    if (!(error instanceof UnsupportedSchemaError)) throw error;
    // A problem of the registration, not of the request
    logger.error('Task group settings format cannot be read', error, {
      function: 'verifyTaskGroupSettings',
      metadata: { taskGroupID, taskGroupVersion },
    });
    return errorResponse('server_error', 'Task group format cannot be read', 500, context);
  }

  if (!validation.valid) {
    return errorResponse(
      'invalid_request',
      `Field 'settings' does not match the task group settings format: ${validation.path} ${validation.message}`,
      400,
      context,
    );
  }
  return null;
}

async function createTaskGroupStage(
  supabaseClient: SupabaseClient,
  context: ResponseContext,
  schedulerID: string,
  body: CreateStageRequestBody,
): Promise<Response> {
  const crawlerField = findPresentField(body, CRAWLER_STAGE_FIELDS);
  if (crawlerField !== undefined) {
    return errorResponse('invalid_request', `Field '${crawlerField}' is not allowed on a task group stage`, 400, context);
  }

  if (!isTaskGroupID(body.task_group_id)) {
    return errorResponse('invalid_request', "Field 'task_group_id' is required and must be a task group ID", 400, context);
  }

  if (!isPositiveInteger(body.task_group_version)) {
    return errorResponse('invalid_request', "Field 'task_group_version' is required and must be a positive integer", 400, context);
  }

  if (typeof body.stage_order !== 'number' || !Number.isInteger(body.stage_order) || body.stage_order < 0) {
    return errorResponse('invalid_request', "Field 'stage_order' is required and must be a non-negative integer", 400, context);
  }

  if (!isPlainObject(body.settings)) {
    return errorResponse('invalid_request', "Field 'settings' is required and must be a JSON object", 400, context);
  }

  const settingsError = await verifyTaskGroupSettings(supabaseClient, context, body.task_group_id, body.task_group_version, body.settings);
  if (settingsError) return settingsError;

  try {
    const stage = await createSchedulerStage(supabaseClient, {
      scheduler_id: schedulerID,
      stage_type: 'task_group',
      crawler_id: null,
      task_group_id: body.task_group_id,
      task_group_version: body.task_group_version,
      settings: body.settings,
      stage_order: body.stage_order,
      input_schema: {},
    });

    return jsonResponse(stage, 201, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('unique') || message.includes('UNIQUE') || message.includes('23505')) {
      return errorResponse('conflict', 'A stage with this order already exists', 409, context);
    }
    // The version was removed after the check
    if (message.includes('RESTRICT') || message.includes('23503') || message.includes('violates foreign key')) {
      return errorResponse('invalid_request', notRegisteredDescription(body.task_group_id, body.task_group_version), 400, context);
    }
    throw error;
  }
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

  if (body.stage_type !== undefined && body.stage_type !== 'crawler' && body.stage_type !== 'task_group') {
    return errorResponse('invalid_request', "Field 'stage_type' must be 'crawler' or 'task_group'", 400, context);
  }

  if (body.stage_type === 'task_group') {
    return await createTaskGroupStage(supabaseClient, context, schedulerID, body);
  }

  const taskGroupField = findPresentField(body, TASK_GROUP_STAGE_FIELDS);
  if (taskGroupField !== undefined) {
    return errorResponse('invalid_request', `Field '${taskGroupField}' is not allowed on a crawler stage`, 400, context);
  }

  if (typeof body.crawler_id !== 'string' || !UUID_PATTERN.test(body.crawler_id)) {
    return errorResponse('invalid_request', "Field 'crawler_id' is required and must be a valid UUID", 400, context);
  }

  const crawlerPermission = await getCrawlerPermission(supabaseClient, body.crawler_id, userUUID);
  if (crawlerPermission === undefined) {
    return errorResponse('forbidden', 'You do not have permission to use this crawler', 403, context);
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

  if (body.fan_out_strategy !== undefined) {
    if (body.fan_out_strategy !== 'compact' && body.fan_out_strategy !== 'preserve') {
      return errorResponse('invalid_request', "Field 'fan_out_strategy' must be 'compact' or 'preserve'", 400, context);
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
      fan_out_strategy: body.fan_out_strategy,
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

  // A stage changes its type or its group by being deleted and created again
  const unchangeableField = findPresentField(body, ['stage_type', 'task_group_id']);
  if (unchangeableField !== undefined) {
    return errorResponse('invalid_request', `Field '${unchangeableField}' cannot be changed`, 400, context);
  }

  // The fields a stage accepts depend on its type
  const currentStage = await getSchedulerStage(supabaseClient, stageID, schedulerID);
  if (!currentStage) {
    return errorResponse('not_found', 'Stage not found', 404, context);
  }

  if (currentStage.stage_type === 'task_group') {
    return await updateTaskGroupStage(supabaseClient, context, schedulerID, currentStage, body);
  }

  const taskGroupField = findPresentField(body, ['task_group_version', 'settings']);
  if (taskGroupField !== undefined) {
    return errorResponse('invalid_request', `Field '${taskGroupField}' is not allowed on a crawler stage`, 400, context);
  }

  if (body.crawler_id !== undefined) {
    if (typeof body.crawler_id !== 'string' || !UUID_PATTERN.test(body.crawler_id)) {
      return errorResponse('invalid_request', "Field 'crawler_id' must be a valid UUID", 400, context);
    }

    const crawlerPermission = await getCrawlerPermission(supabaseClient, body.crawler_id, userUUID);
    if (crawlerPermission === undefined) {
      return errorResponse('forbidden', 'You do not have permission to use this crawler', 403, context);
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

  if (body.fan_out_strategy !== undefined) {
    if (body.fan_out_strategy !== 'compact' && body.fan_out_strategy !== 'preserve') {
      return errorResponse('invalid_request', "Field 'fan_out_strategy' must be 'compact' or 'preserve'", 400, context);
    }
  }

  if (body.crawler_id === undefined && body.input_schema === undefined && body.output_schema === undefined && body.fan_out_field === undefined && body.fan_out_strategy === undefined) {
    return errorResponse('invalid_request', 'At least one field must be provided for update', 400, context);
  }

  const updatePayload: Record<string, unknown> = {};
  if (body.crawler_id !== undefined) updatePayload.crawler_id = body.crawler_id;
  if (body.input_schema !== undefined) updatePayload.input_schema = body.input_schema;
  if (body.output_schema !== undefined) updatePayload.output_schema = body.output_schema;
  if (body.fan_out_field !== undefined) updatePayload.fan_out_field = body.fan_out_field;
  if (body.fan_out_strategy !== undefined) updatePayload.fan_out_strategy = body.fan_out_strategy;

  try {
    const stage = await updateSchedulerStage(supabaseClient, stageID, schedulerID, updatePayload);

    if (!stage) {
      return errorResponse('not_found', 'Stage not found', 404, context);
    }

    return jsonResponse(stage, 200, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // The stage changed after it was read
    if (message.includes(STAGE_TYPE_CONSTRAINT)) {
      return errorResponse('invalid_request', 'Stage fields do not match the stage type', 400, context);
    }
    if (message.includes('RESTRICT') || message.includes('23503') || message.includes('violates foreign key')) {
      return errorResponse('invalid_request', 'Referenced crawler does not exist', 400, context);
    }
    if (message.includes('unique') || message.includes('UNIQUE') || message.includes('23505')) {
      return errorResponse('conflict', 'A stage with this configuration already exists', 409, context);
    }
    throw error;
  }
}

async function updateTaskGroupStage(
  supabaseClient: SupabaseClient,
  context: ResponseContext,
  schedulerID: string,
  currentStage: SchedulerStageRow,
  body: UpdateStageRequestBody,
): Promise<Response> {
  // No crawler permission is checked: a task group stage has no crawler
  const crawlerField = findPresentField(body, CRAWLER_STAGE_FIELDS);
  if (crawlerField !== undefined) {
    return errorResponse('invalid_request', `Field '${crawlerField}' is not allowed on a task group stage`, 400, context);
  }

  if (body.task_group_version !== undefined && !isPositiveInteger(body.task_group_version)) {
    return errorResponse('invalid_request', "Field 'task_group_version' must be a positive integer", 400, context);
  }

  if (body.settings !== undefined && !isPlainObject(body.settings)) {
    return errorResponse('invalid_request', "Field 'settings' must be a JSON object", 400, context);
  }

  if (body.task_group_version === undefined && body.settings === undefined) {
    return errorResponse('invalid_request', 'At least one field must be provided for update', 400, context);
  }

  // scheduler_stages_type_check guarantees both on a task group stage
  const taskGroupID = currentStage.task_group_id!;
  const taskGroupVersion = body.task_group_version ?? currentStage.task_group_version!;
  const settings = body.settings ?? currentStage.settings ?? {};

  // The settings that will be stored must match the version that will be stored
  const settingsError = await verifyTaskGroupSettings(supabaseClient, context, taskGroupID, taskGroupVersion, settings);
  if (settingsError) return settingsError;

  const updatePayload: Record<string, unknown> = {};
  if (body.task_group_version !== undefined) updatePayload.task_group_version = body.task_group_version;
  if (body.settings !== undefined) updatePayload.settings = body.settings;

  try {
    const stage = await updateSchedulerStage(supabaseClient, currentStage.id, schedulerID, updatePayload);

    if (!stage) {
      return errorResponse('not_found', 'Stage not found', 404, context);
    }

    return jsonResponse(stage, 200, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // The stage changed after it was read
    if (message.includes(STAGE_TYPE_CONSTRAINT)) {
      return errorResponse('invalid_request', 'Stage fields do not match the stage type', 400, context);
    }
    // The version was removed after the check
    if (message.includes('RESTRICT') || message.includes('23503') || message.includes('violates foreign key')) {
      return errorResponse('invalid_request', notRegisteredDescription(taskGroupID, taskGroupVersion), 400, context);
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
