import {
  createSchedulerBodySchema,
  updateSchedulerBodySchema,
} from '@audio-underview/schemas';
import {
  errorResponse,
  formatValidationIssues,
  jsonResponse,
  readJSONBody,
  readPaginationQuery,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from '../environment.ts';
import type { SchedulerManagerServices } from '../services.ts';

type Context = RequestContext<WorkerEnvironment>;

export const handleCreateScheduler = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = createSchedulerBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  const created = await services.schedulers.create({
    user_uuid: context.userUUID ?? '',
    name: parsed.data.name,
    cron_expression: parsed.data.cron_expression ?? null,
    ...(parsed.data.is_enabled !== undefined && { is_enabled: parsed.data.is_enabled }),
  });
  return jsonResponse(created, 201, context.responseContext);
};

export const handleListSchedulers = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const pagination = readPaginationQuery(context.url);
  if (!pagination.success) {
    return errorResponse(
      'invalid_request',
      pagination.errorDescription,
      400,
      context.responseContext,
    );
  }
  const { offset, limit } = pagination.value;
  const { data, total } = await services.schedulers.list(context.userUUID ?? '', {
    offset,
    limit,
  });
  return jsonResponse({ data, total, offset, limit }, 200, context.responseContext);
};

export const handleGetScheduler = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const scheduler = await services.schedulers.get(
    context.parameters.schedulerID ?? '',
    context.userUUID ?? '',
  );
  if (scheduler === undefined) {
    return errorResponse('not_found', 'Scheduler not found', 404, context.responseContext);
  }
  return jsonResponse(scheduler, 200, context.responseContext);
};

/** PUT — 부분 업데이트 (최소 1개 필드, `cron_expression: null` 허용) */
export const handleUpdateScheduler = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = updateSchedulerBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  const updated = await services.schedulers.update(
    context.parameters.schedulerID ?? '',
    context.userUUID ?? '',
    {
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.cron_expression !== undefined && {
        cron_expression: parsed.data.cron_expression,
      }),
      ...(parsed.data.is_enabled !== undefined && { is_enabled: parsed.data.is_enabled }),
    },
  );
  if (updated === undefined) {
    return errorResponse('not_found', 'Scheduler not found', 404, context.responseContext);
  }
  return jsonResponse(updated, 200, context.responseContext);
};

export const handleDeleteScheduler = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const deleted = await services.schedulers.delete(
    context.parameters.schedulerID ?? '',
    context.userUUID ?? '',
  );
  if (!deleted) {
    return errorResponse('not_found', 'Scheduler not found', 404, context.responseContext);
  }
  return jsonResponse({ deleted: true }, 200, context.responseContext);
};
