import {
  type ResponseContext,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createScheduler,
  listSchedulersByUser,
  getScheduler,
  updateScheduler,
  deleteScheduler,
} from '@audio-underview/supabase-connector';
import type { Environment } from '../index.ts';
import { isValidCronExpression } from './tools.ts';

interface CreateSchedulerRequestBody {
  name: string;
  cron_expression?: string;
  is_enabled?: boolean;
}

interface UpdateSchedulerRequestBody {
  name?: string;
  cron_expression?: string | null;
  is_enabled?: boolean;
}

const MAX_NAME_LENGTH = 255;
const MAX_CRON_EXPRESSION_LENGTH = 100;

async function validateCreateSchedulerBody(
  request: Request,
  context: ResponseContext,
): Promise<CreateSchedulerRequestBody | Response> {
  let body: CreateSchedulerRequestBody;
  try {
    body = await request.json() as CreateSchedulerRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (typeof body.name !== 'string' || !body.name.trim()) {
    return errorResponse('invalid_request', "Field 'name' is required and must be a non-empty string", 400, context);
  }

  if (body.name.length > MAX_NAME_LENGTH) {
    return errorResponse('invalid_request', `Field 'name' must not exceed ${MAX_NAME_LENGTH} characters`, 400, context);
  }

  if (body.cron_expression !== undefined) {
    if (typeof body.cron_expression !== 'string') {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a string", 400, context);
    }
    if (body.cron_expression.length > MAX_CRON_EXPRESSION_LENGTH) {
      return errorResponse('invalid_request', `Field 'cron_expression' must not exceed ${MAX_CRON_EXPRESSION_LENGTH} characters`, 400, context);
    }
    if (!isValidCronExpression(body.cron_expression)) {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a valid cron expression", 400, context);
    }
  }

  if (body.is_enabled !== undefined && typeof body.is_enabled !== 'boolean') {
    return errorResponse('invalid_request', "Field 'is_enabled' must be a boolean", 400, context);
  }

  return body;
}

async function validateUpdateSchedulerBody(
  request: Request,
  context: ResponseContext,
): Promise<UpdateSchedulerRequestBody | Response> {
  let body: UpdateSchedulerRequestBody;
  try {
    body = await request.json() as UpdateSchedulerRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return errorResponse('invalid_request', "Field 'name' must be a non-empty string", 400, context);
    }
    if (body.name.length > MAX_NAME_LENGTH) {
      return errorResponse('invalid_request', `Field 'name' must not exceed ${MAX_NAME_LENGTH} characters`, 400, context);
    }
  }

  if (body.cron_expression !== undefined && body.cron_expression !== null) {
    if (typeof body.cron_expression !== 'string') {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a string or null", 400, context);
    }
    if (body.cron_expression.length > MAX_CRON_EXPRESSION_LENGTH) {
      return errorResponse('invalid_request', `Field 'cron_expression' must not exceed ${MAX_CRON_EXPRESSION_LENGTH} characters`, 400, context);
    }
    if (!isValidCronExpression(body.cron_expression)) {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a valid cron expression", 400, context);
    }
  }

  if (body.is_enabled !== undefined && typeof body.is_enabled !== 'boolean') {
    return errorResponse('invalid_request', "Field 'is_enabled' must be a boolean", 400, context);
  }

  if (body.name === undefined && body.cron_expression === undefined && body.is_enabled === undefined) {
    return errorResponse('invalid_request', 'At least one field must be provided for update', 400, context);
  }

  return body;
}

export async function handleCreateScheduler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  const validationResult = await validateCreateSchedulerBody(request, context);
  if (validationResult instanceof Response) {
    return validationResult;
  }
  const body = validationResult;

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const scheduler = await createScheduler(supabaseClient, {
    user_uuid: userUUID,
    name: body.name,
    cron_expression: body.cron_expression,
    is_enabled: body.is_enabled,
  });

  return jsonResponse(scheduler, 201, context);
}

export async function handleListSchedulers(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
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

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const result = await listSchedulersByUser(supabaseClient, userUUID, { offset, limit });
  return jsonResponse({
    data: result.data,
    total: result.total,
    offset: offset ?? 0,
    limit: limit ?? 20,
  }, 200, context);
}

export async function handleGetScheduler(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const scheduler = await getScheduler(supabaseClient, schedulerID, userUUID);
  if (!scheduler) {
    return errorResponse('not_found', 'Scheduler not found', 404, context);
  }

  return jsonResponse(scheduler, 200, context);
}

export async function handleUpdateScheduler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  userUUID: string,
): Promise<Response> {
  const validationResult = await validateUpdateSchedulerBody(request, context);
  if (validationResult instanceof Response) {
    return validationResult;
  }
  const body = validationResult;

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const updatePayload: Record<string, unknown> = {};
  if (body.name !== undefined) updatePayload.name = body.name;
  if (body.cron_expression !== undefined) updatePayload.cron_expression = body.cron_expression;
  if (body.is_enabled !== undefined) updatePayload.is_enabled = body.is_enabled;

  const scheduler = await updateScheduler(supabaseClient, schedulerID, userUUID, updatePayload);

  if (!scheduler) {
    return errorResponse('not_found', 'Scheduler not found or not owned by you', 404, context);
  }

  return jsonResponse(scheduler, 200, context);
}

export async function handleDeleteScheduler(
  environment: Environment,
  context: ResponseContext,
  schedulerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const deleted = await deleteScheduler(supabaseClient, schedulerID, userUUID);
  if (!deleted) {
    return errorResponse('not_found', 'Scheduler not found or not owned by you', 404, context);
  }

  return jsonResponse({ deleted: true }, 200, context);
}
