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
import {
  DEFAULT_TIMEZONE,
  isScheduleMinuteAllowed,
  isValidTimezone,
  isScheduleTimezoneAllowed,
  computeNextRunAt,
  resolveNextRunAt,
} from '../schedule.ts';

interface CreateSchedulerRequestBody {
  name: string;
  cron_expression?: string;
  timezone?: string;
  is_enabled?: boolean;
}

interface UpdateSchedulerRequestBody {
  name?: string;
  cron_expression?: string | null;
  timezone?: string;
  is_enabled?: boolean;
}

const MAX_NAME_LENGTH = 255;
const MAX_CRON_EXPRESSION_LENGTH = 100;

// `null` counts as present, so it is rejected rather than treated as "use the default".
function validateTimezone(timezone: unknown, context: ResponseContext): Response | null {
  if (timezone === undefined) {
    return null;
  }
  if (typeof timezone !== 'string') {
    return errorResponse('invalid_request', "Field 'timezone' must be a string", 400, context);
  }
  if (!isValidTimezone(timezone)) {
    return errorResponse('invalid_request', "Field 'timezone' must be a valid IANA time zone", 400, context);
  }
  if (!isScheduleTimezoneAllowed(timezone, new Date())) {
    return errorResponse('invalid_request', "Field 'timezone' must have a UTC offset in whole multiples of 10 minutes", 400, context);
  }
  return null;
}

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

  const timezoneError = validateTimezone(body.timezone, context);
  if (timezoneError) {
    return timezoneError;
  }

  if (typeof body.cron_expression === 'string') {
    if (!isScheduleMinuteAllowed(body.cron_expression)) {
      return errorResponse('invalid_request', "Field 'cron_expression' minute must be 0, 10, 20, 30, 40 or 50", 400, context);
    }
    if (computeNextRunAt(body.cron_expression, body.timezone ?? DEFAULT_TIMEZONE, new Date()) === null) {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a valid cron expression", 400, context);
    }
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

  if (
    body.name === undefined &&
    body.cron_expression === undefined &&
    body.timezone === undefined &&
    body.is_enabled === undefined
  ) {
    return errorResponse('invalid_request', 'At least one field must be provided for update', 400, context);
  }

  const timezoneError = validateTimezone(body.timezone, context);
  if (timezoneError) {
    return timezoneError;
  }

  // The next-run check needs the stored time zone, so the handler runs it after reading the current row.
  if (typeof body.cron_expression === 'string' && !isScheduleMinuteAllowed(body.cron_expression)) {
    return errorResponse('invalid_request', "Field 'cron_expression' minute must be 0, 10, 20, 30, 40 or 50", 400, context);
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

  const timezone = body.timezone ?? DEFAULT_TIMEZONE;
  const scheduler = await createScheduler(supabaseClient, {
    user_uuid: userUUID,
    name: body.name,
    cron_expression: body.cron_expression,
    timezone,
    is_enabled: body.is_enabled,
    next_run_at: resolveNextRunAt({
      cron_expression: body.cron_expression ?? null,
      timezone,
      is_enabled: body.is_enabled ?? true,
    }, new Date()),
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
  if (body.timezone !== undefined) updatePayload.timezone = body.timezone;
  if (body.is_enabled !== undefined) updatePayload.is_enabled = body.is_enabled;

  // A change to what decides the next run recomputes next_run_at from the stored row with the
  // request applied. A name-only change leaves next_run_at alone.
  if (body.cron_expression !== undefined || body.timezone !== undefined || body.is_enabled !== undefined) {
    const current = await getScheduler(supabaseClient, schedulerID, userUUID);
    if (!current) {
      return errorResponse('not_found', 'Scheduler not found or not owned by you', 404, context);
    }

    const overlaid = {
      cron_expression: body.cron_expression !== undefined ? body.cron_expression : current.cron_expression,
      timezone: body.timezone ?? current.timezone,
      is_enabled: body.is_enabled ?? current.is_enabled,
    };
    const now = new Date();

    if (typeof body.cron_expression === 'string' && computeNextRunAt(body.cron_expression, overlaid.timezone, now) === null) {
      return errorResponse('invalid_request', "Field 'cron_expression' must be a valid cron expression", 400, context);
    }

    updatePayload.next_run_at = resolveNextRunAt(overlaid, now);
  }

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
