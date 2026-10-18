import { type ResponseContext, errorResponse } from '@audio-underview/worker-tools';

export const DEFAULT_PAGE_OFFSET = 0;
export const DEFAULT_PAGE_LIMIT = 20;
export const MAXIMUM_PAGE_LIMIT = 100;

export interface Pagination {
  offset: number;
  limit: number;
}

/**
 * The offset and limit query parameters of a list (GET /crawlers and the run lists), with their defaults.
 *
 * @returns a 400 response when a parameter is not valid
 */
export function readPagination(url: URL, context: ResponseContext): Pagination | Response {
  const offsetParameter = url.searchParams.get('offset');
  const limitParameter = url.searchParams.get('limit');

  let offset = DEFAULT_PAGE_OFFSET;
  let limit = DEFAULT_PAGE_LIMIT;

  if (offsetParameter !== null) {
    offset = Number(offsetParameter);
    if (!Number.isInteger(offset) || offset < 0) {
      return errorResponse('invalid_request', "Parameter 'offset' must be a non-negative integer", 400, context);
    }
  }

  if (limitParameter !== null) {
    limit = Number(limitParameter);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_PAGE_LIMIT) {
      return errorResponse('invalid_request', `Parameter 'limit' must be an integer between 1 and ${MAXIMUM_PAGE_LIMIT}`, 400, context);
    }
  }

  return { offset, limit };
}
