import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import { createWorkerRouter, type WorkerRouter } from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from './environment.ts';
import { handleExecuteScheduler } from './handlers/scheduler-execution.ts';
import { handleGetRun, handleListRuns } from './handlers/scheduler-runs.ts';
import {
  handleCreateStage,
  handleDeleteStage,
  handleGetStage,
  handleListStages,
  handleReorderStages,
  handleUpdateStage,
} from './handlers/scheduler-stages.ts';
import {
  handleCreateScheduler,
  handleDeleteScheduler,
  handleGetScheduler,
  handleListSchedulers,
  handleUpdateScheduler,
} from './handlers/schedulers.ts';
import type { ResolveServices } from './services.ts';

export const SERVICE_NAME = 'audio-underview-scheduler-manager-worker';

export const createSchedulerManagerRouter = (
  resolveServices: ResolveServices,
): WorkerRouter<WorkerEnvironment> =>
  createWorkerRouter<WorkerEnvironment>({
    serviceName: SERVICE_NAME,
    help: [
      { method: 'GET', path: '/', description: 'Service help' },
      { method: 'POST', path: '/schedulers', description: 'Create a scheduler' },
      { method: 'GET', path: '/schedulers', description: 'List schedulers (offset/limit)' },
      { method: 'GET', path: '/schedulers/:schedulerID', description: 'Get a scheduler' },
      { method: 'PUT', path: '/schedulers/:schedulerID', description: 'Update a scheduler' },
      { method: 'DELETE', path: '/schedulers/:schedulerID', description: 'Delete a scheduler' },
      { method: 'POST', path: '/schedulers/:schedulerID/stages', description: 'Add a stage' },
      { method: 'GET', path: '/schedulers/:schedulerID/stages', description: 'List stages' },
      { method: 'PUT', path: '/schedulers/:schedulerID/stages/reorder', description: 'Reorder stages' },
      { method: 'GET', path: '/schedulers/:schedulerID/stages/:stageID', description: 'Get a stage' },
      { method: 'PUT', path: '/schedulers/:schedulerID/stages/:stageID', description: 'Update a stage' },
      { method: 'DELETE', path: '/schedulers/:schedulerID/stages/:stageID', description: 'Delete a stage' },
      { method: 'GET', path: '/schedulers/:schedulerID/runs', description: 'List runs' },
      { method: 'GET', path: '/schedulers/:schedulerID/runs/:runID', description: 'Get a run' },
      { method: 'POST', path: '/schedulers/:schedulerID/execute', description: 'Execute the pipeline' },
    ],
    cors: {
      allowMethods: 'GET, POST, PUT, DELETE, OPTIONS',
      allowHeaders: 'Content-Type, Authorization',
    },
    resolveAllowedOrigins: (environment) => environment.ALLOWED_ORIGINS,
    resolveAuthentication: (environment) =>
      environment.JWT_SECRET === undefined
        ? undefined
        : { secret: environment.JWT_SECRET, issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
    routes: [
      // ---- schedulers ----
      {
        method: 'POST',
        pattern: '/schedulers',
        requiresAuthentication: true,
        handler: (context) => handleCreateScheduler(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/schedulers',
        requiresAuthentication: true,
        handler: (context) => handleListSchedulers(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/schedulers/:schedulerID',
        requiresAuthentication: true,
        handler: (context) => handleGetScheduler(context, resolveServices(context.environment)),
      },
      {
        method: 'PUT',
        pattern: '/schedulers/:schedulerID',
        requiresAuthentication: true,
        handler: (context) => handleUpdateScheduler(context, resolveServices(context.environment)),
      },
      {
        method: 'DELETE',
        pattern: '/schedulers/:schedulerID',
        requiresAuthentication: true,
        handler: (context) => handleDeleteScheduler(context, resolveServices(context.environment)),
      },
      // ---- stages ('reorder'는 예약어 — :stageID보다 먼저 등록) ----
      {
        method: 'PUT',
        pattern: '/schedulers/:schedulerID/stages/reorder',
        requiresAuthentication: true,
        handler: (context) => handleReorderStages(context, resolveServices(context.environment)),
      },
      {
        method: 'POST',
        pattern: '/schedulers/:schedulerID/stages',
        requiresAuthentication: true,
        handler: (context) => handleCreateStage(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/schedulers/:schedulerID/stages',
        requiresAuthentication: true,
        handler: (context) => handleListStages(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/schedulers/:schedulerID/stages/:stageID',
        requiresAuthentication: true,
        handler: (context) => handleGetStage(context, resolveServices(context.environment)),
      },
      {
        method: 'PUT',
        pattern: '/schedulers/:schedulerID/stages/:stageID',
        requiresAuthentication: true,
        handler: (context) => handleUpdateStage(context, resolveServices(context.environment)),
      },
      {
        method: 'DELETE',
        pattern: '/schedulers/:schedulerID/stages/:stageID',
        requiresAuthentication: true,
        handler: (context) => handleDeleteStage(context, resolveServices(context.environment)),
      },
      // ---- runs ----
      {
        method: 'GET',
        pattern: '/schedulers/:schedulerID/runs',
        requiresAuthentication: true,
        handler: (context) => handleListRuns(context, resolveServices(context.environment)),
      },
      {
        method: 'GET',
        pattern: '/schedulers/:schedulerID/runs/:runID',
        requiresAuthentication: true,
        handler: (context) => handleGetRun(context, resolveServices(context.environment)),
      },
      // ---- execution ----
      {
        method: 'POST',
        pattern: '/schedulers/:schedulerID/execute',
        requiresAuthentication: true,
        handler: (context) => handleExecuteScheduler(context, resolveServices(context.environment)),
      },
    ],
  });
