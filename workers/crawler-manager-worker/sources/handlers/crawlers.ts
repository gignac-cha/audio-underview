import {
  isForeignKeyViolation,
} from '@audio-underview/database-connector';
import {
  saveCrawlerBodySchema,
  type SaveCrawlerBody,
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
import { isSafeURLPattern } from '../safe-url-patterns.ts';
import type { CrawlerManagerServices } from '../services.ts';

type Context = RequestContext<WorkerEnvironment>;

/**
 * body 검증 + 서버 정규화 (스펙 §3.2):
 * - web: `input_schema = { body: 'string' }` 강제, ReDoS 안전성 hard check
 * - data: `url_pattern = null` 저장
 */
type NormalizedCrawlerBody = Omit<SaveCrawlerBody, 'url_pattern'> & {
  url_pattern: string | null;
};

const validateAndNormalizeBody = async (
  context: Context,
): Promise<
  { success: true; value: NormalizedCrawlerBody } | { success: false; response: Response }
> => {
  const body = await readJSONBody(context.request);
  if (!body.success) {
    return {
      success: false,
      response: errorResponse(
        'invalid_request',
        'Request body must be valid JSON',
        400,
        context.responseContext,
      ),
    };
  }

  const parsed = saveCrawlerBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return {
      success: false,
      response: errorResponse(
        'invalid_request',
        formatValidationIssues(parsed.error),
        400,
        context.responseContext,
      ),
    };
  }

  const crawler = parsed.data;
  if (crawler.type === 'web') {
    if (crawler.url_pattern !== undefined && !isSafeURLPattern(crawler.url_pattern)) {
      return {
        success: false,
        response: errorResponse(
          'invalid_request',
          "Field 'url_pattern' contains potentially unsafe regex pattern",
          400,
          context.responseContext,
        ),
      };
    }
    return {
      success: true,
      value: {
        ...crawler,
        url_pattern: crawler.url_pattern ?? null,
        input_schema: { body: 'string' },
      },
    };
  }

  return { success: true, value: { ...crawler, url_pattern: null } };
};

export const handleCreateCrawler = async (
  context: Context,
  services: CrawlerManagerServices,
): Promise<Response> => {
  const validated = await validateAndNormalizeBody(context);
  if (!validated.success) {
    return validated.response;
  }
  const body = validated.value;

  const created = await services.crawlers.createWithOwnerPermission({
    userUUID: context.userUUID ?? '',
    name: body.name,
    type: body.type,
    urlPattern: body.url_pattern,
    code: body.code,
    inputSchema: body.input_schema ?? {},
    outputSchema: body.output_schema ?? {},
  });
  return jsonResponse(created, 201, context.responseContext);
};

export const handleListCrawlers = async (
  context: Context,
  services: CrawlerManagerServices,
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
  const { data, total } = await services.crawlers.list(context.userUUID ?? '', { offset, limit });
  return jsonResponse({ data, total, offset, limit }, 200, context.responseContext);
};

export const handleGetCrawler = async (
  context: Context,
  services: CrawlerManagerServices,
): Promise<Response> => {
  const crawler = await services.crawlers.get(
    context.parameters.crawlerID ?? '',
    context.userUUID ?? '',
  );
  if (crawler === undefined) {
    return errorResponse('not_found', 'Crawler not found', 404, context.responseContext);
  }
  return jsonResponse(crawler, 200, context.responseContext);
};

/** PUT — 전체 교체 (create와 동일 검증 — 스펙 §3.1) */
export const handleUpdateCrawler = async (
  context: Context,
  services: CrawlerManagerServices,
): Promise<Response> => {
  const validated = await validateAndNormalizeBody(context);
  if (!validated.success) {
    return validated.response;
  }
  const body = validated.value;

  const updated = await services.crawlers.update(
    context.parameters.crawlerID ?? '',
    context.userUUID ?? '',
    {
      name: body.name,
      type: body.type,
      url_pattern: body.url_pattern,
      code: body.code,
      input_schema: body.input_schema ?? {},
      output_schema: body.output_schema ?? {},
    },
  );
  if (updated === undefined) {
    return errorResponse(
      'not_found',
      'Crawler not found or not owned by you',
      404,
      context.responseContext,
    );
  }
  return jsonResponse(updated, 200, context.responseContext);
};

export const handleDeleteCrawler = async (
  context: Context,
  services: CrawlerManagerServices,
): Promise<Response> => {
  try {
    const deleted = await services.crawlers.delete(
      context.parameters.crawlerID ?? '',
      context.userUUID ?? '',
    );
    if (!deleted) {
      return errorResponse('not_found', 'Crawler not found', 404, context.responseContext);
    }
    return jsonResponse({ deleted: true }, 200, context.responseContext);
  } catch (error) {
    // scheduler stage가 참조 중 (FK RESTRICT) — 레거시는 500이었으나 409로 개선 (스펙 §8.13)
    if (isForeignKeyViolation(error)) {
      return errorResponse(
        'conflict',
        'Crawler is referenced by scheduler stages and cannot be deleted',
        409,
        context.responseContext,
      );
    }
    throw error;
  }
};
