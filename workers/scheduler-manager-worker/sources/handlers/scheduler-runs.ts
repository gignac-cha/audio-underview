import {
  errorResponse,
  jsonResponse,
  readPaginationQuery,
  type RequestContext,
} from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from '../environment.ts';
import type { SchedulerManagerServices } from '../services.ts';

type Context = RequestContext<WorkerEnvironment>;

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

export const handleListRuns = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }

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
  const { data, total } = await services.runs.list(context.parameters.schedulerID ?? '', {
    offset,
    limit,
  });
  return jsonResponse({ data, total, offset, limit }, 200, context.responseContext);
};

export const handleGetRun = async (
  context: Context,
  services: SchedulerManagerServices,
): Promise<Response> => {
  const ownershipFailure = await verifySchedulerOwnership(context, services);
  if (ownershipFailure !== undefined) {
    return ownershipFailure;
  }
  const run = await services.runs.get(
    context.parameters.runID ?? '',
    context.parameters.schedulerID ?? '',
  );
  if (run === undefined) {
    return errorResponse('not_found', 'Run not found', 404, context.responseContext);
  }
  return jsonResponse(run, 200, context.responseContext);
};
