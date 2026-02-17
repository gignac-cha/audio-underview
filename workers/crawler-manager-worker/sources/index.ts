import { createWorkerLogger } from '@audio-underview/logger';
import {
  type ResponseContext,
  createCORSHeaders,
  jsonResponse,
  errorResponse,
} from '@audio-underview/worker-tools';
import {
  createSupabaseClient,
  createCrawler,
  listCrawlersByUser,
  getCrawler,
  deleteCrawler,
} from '@audio-underview/supabase-connector';
import { authenticateRequest } from './authentication.ts';

interface Environment {
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}

interface CreateCrawlerRequestBody {
  name: string;
  url_pattern: string;
  code: string;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'crawler-manager-worker',
  },
});

const HELP = {
  name: 'crawler-manager-worker',
  endpoints: [
    { method: 'GET', path: '/', description: 'Show this help' },
    { method: 'POST', path: '/crawlers', description: 'Create a crawler' },
    { method: 'GET', path: '/crawlers', description: 'List crawlers for the authenticated user' },
    { method: 'GET', path: '/crawlers/:id', description: 'Get a crawler by ID' },
    { method: 'DELETE', path: '/crawlers/:id', description: 'Delete a crawler by ID' },
  ],
};

async function handleCreateCrawler(
  request: Request,
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  let body: CreateCrawlerRequestBody;
  try {
    body = await request.json() as CreateCrawlerRequestBody;
  } catch {
    return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
  }

  if (!body.name || typeof body.name !== 'string') {
    return errorResponse('invalid_request', "Field 'name' is required and must be a string", 400, context);
  }

  if (!body.url_pattern || typeof body.url_pattern !== 'string') {
    return errorResponse('invalid_request', "Field 'url_pattern' is required and must be a string", 400, context);
  }

  if (!body.code || typeof body.code !== 'string') {
    return errorResponse('invalid_request', "Field 'code' is required and must be a string", 400, context);
  }

  try {
    new RegExp(body.url_pattern);
  } catch {
    return errorResponse('invalid_request', "Field 'url_pattern' must be a valid regex", 400, context);
  }

  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const crawler = await createCrawler(supabaseClient, {
    user_uuid: userUUID,
    name: body.name,
    url_pattern: body.url_pattern,
    code: body.code,
  });

  return jsonResponse(crawler, 201, context);
}

async function handleListCrawlers(
  environment: Environment,
  context: ResponseContext,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const crawlers = await listCrawlersByUser(supabaseClient, userUUID);
  return jsonResponse(crawlers, 200, context);
}

async function handleGetCrawler(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const crawler = await getCrawler(supabaseClient, crawlerID);
  if (!crawler) {
    return errorResponse('not_found', 'Crawler not found', 404, context);
  }

  return jsonResponse(crawler, 200, context);
}

async function handleDeleteCrawler(
  environment: Environment,
  context: ResponseContext,
  crawlerID: string,
  userUUID: string,
): Promise<Response> {
  const supabaseClient = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  const deleted = await deleteCrawler(supabaseClient, crawlerID, userUUID);
  if (!deleted) {
    return errorResponse('not_found', 'Crawler not found or not owned by you', 404, context);
  }

  return jsonResponse({ deleted: true }, 200, context);
}

function parseCrawlerID(pathname: string): string | null {
  const match = pathname.match(/^\/crawlers\/([0-9a-f-]+)$/);
  return match?.[1] ?? null;
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
      headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/help')) {
        return jsonResponse(HELP, 200, context);
      }

      // All /crawlers routes require authentication
      if (url.pathname.startsWith('/crawlers')) {
        const supabaseClient = createSupabaseClient({
          supabaseURL: environment.SUPABASE_URL,
          supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
        });

        const userUUID = await authenticateRequest(request, supabaseClient);
        if (!userUUID) {
          return errorResponse('unauthorized', 'Valid authentication is required', 401, context);
        }

        // POST /crawlers — create
        if (url.pathname === '/crawlers' && request.method === 'POST') {
          return await handleCreateCrawler(request, environment, context, userUUID);
        }

        // GET /crawlers — list
        if (url.pathname === '/crawlers' && request.method === 'GET') {
          return await handleListCrawlers(environment, context, userUUID);
        }

        // GET /crawlers/:id — get single
        const crawlerID = parseCrawlerID(url.pathname);
        if (crawlerID && request.method === 'GET') {
          return await handleGetCrawler(environment, context, crawlerID);
        }

        // DELETE /crawlers/:id — delete
        if (crawlerID && request.method === 'DELETE') {
          return await handleDeleteCrawler(environment, context, crawlerID, userUUID);
        }

        const response = errorResponse('method_not_allowed', 'Method not allowed', 405, context);
        response.headers.set('Allow', 'GET, POST, DELETE, OPTIONS');
        return response;
      }

      return errorResponse('not_found', 'Endpoint not found', 404, context);
    } catch (error) {
      logger.error('Unhandled worker error', error, { function: 'fetch' });
      return errorResponse('server_error', 'An unexpected error occurred', 500, context);
    }
  },
};
