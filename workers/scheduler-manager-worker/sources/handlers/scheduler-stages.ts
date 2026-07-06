import {
  DatabaseOperationError,
  isForeignKeyViolation,
  isUniqueViolation,
} from '@audio-underview/database-connector';
import {
  createSchedulerStageBodySchema,
  reorderSchedulerStagesBodySchema,
  updateSchedulerStageBodySchema,
} from '@audio-underview/schemas';
import {
  errorResponse,
  formatValidationIssues,
  jsonResponse,
  readJSONBody,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from '../environment.ts';
import type { SchedulerManagerServices } from '../services.ts';

type Context = RequestContext<WorkerEnvironment>;

/**
 * 모든 stage 핸들러는 body 파싱보다 **먼저** scheduler 소유권을 검증한다 (스펙 §4.1).
 * 실패 시 404 반환 (정보 은닉).
 */
const verifySchedulerOwnership = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response | undefined> => {
  const scheduler = await services.schedulers.get(
    context.parameters.schedulerID ?? '',
    context.userUUID ?? '',
  );
  if (scheduler === undefined) {
    return errorResponse('not_found', 'Scheduler not found', 404, context.responseContext);
  }
  return undefined;
};

/** crawler 사용 자격: (crawler_id, user) permission 행 존재 (level 무관 — 스펙 §10.7) */
const verifyCrawlerPermission = async (
  context: Context,
  services: SchedulerManagerServices,
  crawlerID: string,
): Promise<Response | undefined> => {
  const permission = await services.crawlerPermissions.get(crawlerID, context.userUUID ?? '');
  if (permission === undefined) {
    return errorResponse(
      'forbidden',
      'You do not have permission to use this crawler',
      403,
      context.responseContext,
    );
  }
  return undefined;
};

const mapStageDatabaseError = (
  error: unknown,
  context: Context,
  conflictDescription: string,
): Response | undefined => {
  if (isUniqueViolation(error)) {
    return errorResponse('conflict', conflictDescription, 409, context.responseContext);
  }
  if (isForeignKeyViolation(error)) {
    return errorResponse(
      'invalid_request',
      'Referenced crawler does not exist',
      400,
      context.responseContext,
    );
  }
  return undefined;
};

export const handleCreateStage = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }

  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = createSchedulerStageBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  const permissionFailure = await verifyCrawlerPermission(context, services, parsed.data.crawler_id);
  if (permissionFailure !== undefined) {
    return permissionFailure;
  }

  try {
    const created = await services.stages.create({
      scheduler_id: context.parameters.schedulerID ?? '',
      crawler_id: parsed.data.crawler_id,
      stage_order: parsed.data.stage_order,
      input_schema: parsed.data.input_schema,
      output_schema: parsed.data.output_schema ?? {},
      fan_out_field: parsed.data.fan_out_field ?? null,
      ...(parsed.data.fan_out_strategy !== undefined && {
        fan_out_strategy: parsed.data.fan_out_strategy,
      }),
    });
    return jsonResponse(created, 201, context.responseContext);
  } catch (error) {
    const mapped = mapStageDatabaseError(error, context, 'A stage with this order already exists');
    if (mapped !== undefined) {
      return mapped;
    }
    throw error;
  }
};

export const handleListStages = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }
  const stages = await services.stages.list(context.parameters.schedulerID ?? '');
  return jsonResponse({ data: stages }, 200, context.responseContext);
};

export const handleGetStage = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }
  const stage = await services.stages.get(
    context.parameters.stageID ?? '',
    context.parameters.schedulerID ?? '',
  );
  if (stage === undefined) {
    return errorResponse('not_found', 'Stage not found', 404, context.responseContext);
  }
  return jsonResponse(stage, 200, context.responseContext);
};

export const handleUpdateStage = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }

  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = updateSchedulerStageBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  // crawler_id 변경 시 permission 재검증 (스펙 §4.3)
  if (parsed.data.crawler_id !== undefined) {
    const permissionFailure = await verifyCrawlerPermission(
      context,
      services,
      parsed.data.crawler_id,
    );
    if (permissionFailure !== undefined) {
      return permissionFailure;
    }
  }

  try {
    const updated = await services.stages.update(
      context.parameters.stageID ?? '',
      context.parameters.schedulerID ?? '',
      {
        ...(parsed.data.crawler_id !== undefined && { crawler_id: parsed.data.crawler_id }),
        ...(parsed.data.stage_order !== undefined && { stage_order: parsed.data.stage_order }),
        ...(parsed.data.input_schema !== undefined && { input_schema: parsed.data.input_schema }),
        ...(parsed.data.output_schema !== undefined && {
          output_schema: parsed.data.output_schema,
        }),
        ...(parsed.data.fan_out_field !== undefined && {
          fan_out_field: parsed.data.fan_out_field,
        }),
        ...(parsed.data.fan_out_strategy !== undefined && {
          fan_out_strategy: parsed.data.fan_out_strategy,
        }),
      },
    );
    if (updated === undefined) {
      return errorResponse('not_found', 'Stage not found', 404, context.responseContext);
    }
    return jsonResponse(updated, 200, context.responseContext);
  } catch (error) {
    const mapped = mapStageDatabaseError(
      error,
      context,
      'A stage with this configuration already exists',
    );
    if (mapped !== undefined) {
      return mapped;
    }
    throw error;
  }
};

export const handleDeleteStage = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }
  const deleted = await services.stages.delete(
    context.parameters.stageID ?? '',
    context.parameters.schedulerID ?? '',
  );
  if (!deleted) {
    return errorResponse('not_found', 'Stage not found', 404, context.responseContext);
  }
  return jsonResponse({ deleted: true }, 200, context.responseContext);
};

const REORDER_VALIDATION_PATTERN = /mismatch|unknown|not found|validation|23503|violates/i;

/** `PUT /schedulers/:schedulerID/stages/reorder` — 전체 stage id를 순서대로 (스펙 §4.4) */
export const handleReorderStages = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }

  const body = await readJSONBody(context.request);
  if (!body.success) {
    return errorResponse(
      'invalid_request',
      'Request body must be valid JSON',
      400,
      context.responseContext,
    );
  }
  const parsed = reorderSchedulerStagesBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return errorResponse(
      'invalid_request',
      formatValidationIssues(parsed.error),
      400,
      context.responseContext,
    );
  }

  try {
    const stages = await services.stages.reorder(
      context.parameters.schedulerID ?? '',
      parsed.data.stage_ids,
    );
    return jsonResponse({ data: stages }, 200, context.responseContext);
  } catch (error) {
    const message =
      error instanceof DatabaseOperationError || error instanceof Error ? error.message : '';
    if (REORDER_VALIDATION_PATTERN.test(message)) {
      return errorResponse(
        'invalid_request',
        'Stage reorder validation failed',
        400,
        context.responseContext,
      );
    }
    throw error;
  }
};
