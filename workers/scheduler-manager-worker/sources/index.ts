import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
  verifyJWT,
} from '@audio-underview/worker-tools';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import { handleTokenExchange } from './token-exchange.ts';
import {
  handleCreateScheduler,
  handleListSchedulers,
  handleGetScheduler,
  handleUpdateScheduler,
  handleDeleteScheduler,
} from './handlers/schedulers.ts';
import {
  handleCreateStage,
  handleListStages,
  handleGetStage,
  handleUpdateStage,
  handleDeleteStage,
  handleReorderStages,
} from './handlers/scheduler-stages.ts';
import {
  handleListRuns,
  handleGetRun,
} from './handlers/scheduler-runs.ts';
import { UUID_PATTERN } from './handlers/tools.ts';

export interface Environment {
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  JWT_SECRET: string;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'scheduler-manager-worker',
  },
});

const HELP = {
  name: 'scheduler-manager-worker',
  endpoints: [
    { method: 'GET', path: '/', description: 'Show this help' },
    { method: 'POST', path: '/authentication/token', description: 'Exchange OAuth access token for a JWT' },
    { method: 'POST', path: '/schedulers', description: 'Create a scheduler' },
    { method: 'GET', path: '/schedulers', description: 'List schedulers for the authenticated user' },
    { method: 'GET', path: '/schedulers/:id', description: 'Get a scheduler by ID' },
    { method: 'PUT', path: '/schedulers/:id', description: 'Update a scheduler by ID' },
    { method: 'DELETE', path: '/schedulers/:id', description: 'Delete a scheduler by ID' },
    { method: 'POST', path: '/schedulers/:id/stages', description: 'Add a stage to a scheduler' },
    { method: 'GET', path: '/schedulers/:id/stages', description: 'List stages for a scheduler' },
    { method: 'GET', path: '/schedulers/:id/stages/:stageID', description: 'Get a stage by ID' },
    { method: 'PUT', path: '/schedulers/:id/stages/:stageID', description: 'Update a stage' },
    { method: 'DELETE', path: '/schedulers/:id/stages/:stageID', description: 'Delete a stage' },
    { method: 'PUT', path: '/schedulers/:id/stages/reorder', description: 'Reorder stages' },
    { method: 'GET', path: '/schedulers/:id/runs', description: 'List runs for a scheduler' },
    { method: 'GET', path: '/schedulers/:id/runs/:runID', description: 'Get a run by ID' },
  ],
};

interface ParsedRoute {
  type: 'schedulers_collection'
    | 'scheduler_single'
    | 'stages_collection'
    | 'stage_single'
    | 'stages_reorder'
    | 'runs_collection'
    | 'run_single'
    | null;
  schedulerID?: string;
  stageID?: string;
  runID?: string;
}

function parseRoute(pathname: string): ParsedRoute {
  // /schedulers
  if (pathname === '/schedulers') {
    return { type: 'schedulers_collection' };
  }

  // /schedulers/:id
  const schedulerMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)$/i);
  if (schedulerMatch) {
    const id = schedulerMatch[1];
    if (!UUID_PATTERN.test(id)) return { type: null };
    return { type: 'scheduler_single', schedulerID: id };
  }

  // /schedulers/:id/stages/reorder
  const reorderMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)\/stages\/reorder$/i);
  if (reorderMatch) {
    const id = reorderMatch[1];
    if (!UUID_PATTERN.test(id)) return { type: null };
    return { type: 'stages_reorder', schedulerID: id };
  }

  // /schedulers/:id/stages/:stageID
  const stageMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)\/stages\/([0-9a-f-]+)$/i);
  if (stageMatch) {
    const schedulerID = stageMatch[1];
    const stageID = stageMatch[2];
    if (!UUID_PATTERN.test(schedulerID) || !UUID_PATTERN.test(stageID)) return { type: null };
    return { type: 'stage_single', schedulerID, stageID };
  }

  // /schedulers/:id/stages
  const stagesMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)\/stages$/i);
  if (stagesMatch) {
    const id = stagesMatch[1];
    if (!UUID_PATTERN.test(id)) return { type: null };
    return { type: 'stages_collection', schedulerID: id };
  }

  // /schedulers/:id/runs/:runID
  const runMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)\/runs\/([0-9a-f-]+)$/i);
  if (runMatch) {
    const schedulerID = runMatch[1];
    const runID = runMatch[2];
    if (!UUID_PATTERN.test(schedulerID) || !UUID_PATTERN.test(runID)) return { type: null };
    return { type: 'run_single', schedulerID, runID };
  }

  // /schedulers/:id/runs
  const runsMatch = pathname.match(/^\/schedulers\/([0-9a-f-]+)\/runs$/i);
  if (runsMatch) {
    const id = runsMatch[1];
    if (!UUID_PATTERN.test(id)) return { type: null };
    return { type: 'runs_collection', schedulerID: id };
  }

  return { type: null };
}

export default {
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') ?? '';

    logger.info('Request received', {
      method: request.method,
      pathname: url.pathname,
      origin,
    }, { function: 'fetch' });

    if (request.method === 'OPTIONS') {
      const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return new Response(null, { status: 204, headers });
    }

    if (request.method === 'HEAD') {
      const headers = createCORSHeaders(origin, environment.ALLOWED_ORIGINS, logger);
      headers.set('Content-Type', 'application/json');
      return new Response(null, { status: 200, headers });
    }

    const context: ResponseContext = {
      origin,
      allowedOrigins: environment.ALLOWED_ORIGINS,
      logger,
    };

    if (!environment.JWT_SECRET) {
      logger.error('JWT_SECRET is not configured', undefined, { function: 'fetch' });
      return errorResponse('server_error', 'Server configuration error', 500, context);
    }

    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
        return jsonResponse(HELP, 200, context);
      }

      // POST /authentication/token — token exchange (unauthenticated)
      if (url.pathname === '/authentication/token') {
        if (request.method !== 'POST') {
          const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
          response.headers.set('Allow', 'POST');
          return response;
        }
        const supabaseClient = createSupabaseClient({
          supabaseURL: environment.SUPABASE_URL,
          supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
        });
        return await handleTokenExchange(request, supabaseClient, environment.JWT_SECRET, context);
      }

      // All /schedulers routes require JWT authentication
      if (url.pathname === '/schedulers' || url.pathname.startsWith('/schedulers/')) {
        const authorizationHeader = request.headers.get('Authorization');
        if (!authorizationHeader?.startsWith('Bearer ')) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }

        const token = authorizationHeader.slice('Bearer '.length);
        const payload = await verifyJWT(token, environment.JWT_SECRET);
        if (!payload) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }

        const userUUID = payload.sub;
        if (!UUID_PATTERN.test(userUUID)) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }
        const route = parseRoute(url.pathname);

        switch (route.type) {
          case 'schedulers_collection': {
            if (request.method === 'POST') {
              return await handleCreateScheduler(request, environment, context, userUUID);
            }
            if (request.method === 'GET') {
              return await handleListSchedulers(request, environment, context, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET, POST');
            return response;
          }

          case 'scheduler_single': {
            if (request.method === 'GET') {
              return await handleGetScheduler(environment, context, route.schedulerID!, userUUID);
            }
            if (request.method === 'PUT') {
              return await handleUpdateScheduler(request, environment, context, route.schedulerID!, userUUID);
            }
            if (request.method === 'DELETE') {
              return await handleDeleteScheduler(environment, context, route.schedulerID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET, PUT, DELETE');
            return response;
          }

          case 'stages_reorder': {
            if (request.method === 'PUT') {
              return await handleReorderStages(request, environment, context, route.schedulerID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'PUT');
            return response;
          }

          case 'stages_collection': {
            if (request.method === 'POST') {
              return await handleCreateStage(request, environment, context, route.schedulerID!, userUUID);
            }
            if (request.method === 'GET') {
              return await handleListStages(environment, context, route.schedulerID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET, POST');
            return response;
          }

          case 'stage_single': {
            if (request.method === 'GET') {
              return await handleGetStage(environment, context, route.schedulerID!, route.stageID!, userUUID);
            }
            if (request.method === 'PUT') {
              return await handleUpdateStage(request, environment, context, route.schedulerID!, route.stageID!, userUUID);
            }
            if (request.method === 'DELETE') {
              return await handleDeleteStage(environment, context, route.schedulerID!, route.stageID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET, PUT, DELETE');
            return response;
          }

          case 'runs_collection': {
            if (request.method === 'GET') {
              return await handleListRuns(request, environment, context, route.schedulerID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET');
            return response;
          }

          case 'run_single': {
            if (request.method === 'GET') {
              return await handleGetRun(environment, context, route.schedulerID!, route.runID!, userUUID);
            }
            const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
            response.headers.set('Allow', 'GET');
            return response;
          }

          default:
            return errorResponse('not_found', 'Invalid resource path', 404, context);
        }
      }

      return errorResponse('not_found', 'Endpoint not found', 404, context);
    } catch (error) {
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  },
};
