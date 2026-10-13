import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { fetchMock } from 'cloudflare:test';

/**
 * A small in-memory PostgREST behind fetchMock, for tests that follow a run over several tables.
 * It understands the filters, orders and limits the connector sends, whether a request asks for one
 * object (.single()) or an array, and the two RPC functions of migration 013 with its deletion trigger.
 */

export type Row = Record<string, unknown>;

export interface InMemorySupabaseRequest {
  method: string;
  table: string;
  query: URLSearchParams;
  body: unknown;
}

export interface InMemorySupabaseResponse {
  statusCode: number;
  data: unknown;
}

export interface InMemorySupabase {
  tables: Record<string, Row[]>;
  requests: InMemorySupabaseRequest[];
  /** Runs before the tables answer; returning a response answers instead, for example with an error */
  intercept: ((request: InMemorySupabaseRequest) => InMemorySupabaseResponse | undefined) | undefined;
  requestsOf(method: string, table: string): InMemorySupabaseRequest[];
}

const NON_FILTER_PARAMETERS = new Set(['select', 'order', 'limit', 'offset', 'columns']);

// Column defaults of the tables rows are inserted into
const TABLE_DEFAULTS: Record<string, () => Row> = {
  crawler_runs: () => ({ result: null, error_code: null, error: null, logs: [], logs_truncated: false }),
  crawler_files: () => ({ run_id: null, crawler_id: null, name: null, expires_at: null }),
};

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftTime = typeof left === 'string' ? Date.parse(left) : Number.NaN;
  const rightTime = typeof right === 'string' ? Date.parse(right) : Number.NaN;
  if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime)) return leftTime - rightTime;
  return String(left).localeCompare(String(right));
}

function matchesCondition(row: Row, column: string, filter: string): boolean {
  const separatorIndex = filter.indexOf('.');
  const operator = filter.slice(0, separatorIndex);
  const operand = filter.slice(separatorIndex + 1);
  const value = row[column];
  switch (operator) {
    case 'eq':
      return value !== null && value !== undefined && String(value) === operand;
    case 'is':
      if (operand !== 'null') throw new Error(`In-memory Supabase does not support is.${operand}`);
      return value === null || value === undefined;
    case 'gt':
      return value !== null && value !== undefined && compareValues(value, operand) > 0;
    case 'lte':
      return value !== null && value !== undefined && compareValues(value, operand) <= 0;
    case 'in':
      return operand.slice(1, -1).split(',').includes(String(value));
    default:
      throw new Error(`In-memory Supabase does not support the filter ${column}=${filter}`);
  }
}

// or=(a.is.null,b.gt.x): the conditions hold no commas or parentheses here
function matchesAny(row: Row, conditions: string): boolean {
  return conditions.slice(1, -1).split(',').some((condition) => {
    const separatorIndex = condition.indexOf('.');
    return matchesCondition(row, condition.slice(0, separatorIndex), condition.slice(separatorIndex + 1));
  });
}

function matchesFilters(row: Row, query: URLSearchParams): boolean {
  for (const [column, filter] of query) {
    if (NON_FILTER_PARAMETERS.has(column)) continue;
    if (column === 'or') {
      if (!matchesAny(row, filter)) return false;
      continue;
    }
    if (!matchesCondition(row, column, filter)) return false;
  }
  return true;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (order === null) return rows;
  const orders = order.split(',').map((part) => part.split('.'));
  return [...rows].sort((left, right) => {
    for (const [column, direction] of orders) {
      const difference = compareValues(left[column], right[column]) * (direction === 'desc' ? -1 : 1);
      if (difference !== 0) return difference;
    }
    return 0;
  });
}

function headerEntries(headers: unknown): [string, string][] {
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) {
    const entries: [string, string][] = [];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      entries.push([String(headers[index]), String(headers[index + 1])]);
    }
    return entries;
  }
  return Object.entries((headers ?? {}) as Record<string, string>);
}

// .single() asks PostgREST for one object; a list, or a maybeSingle on a GET, asks for an array
function asksForSingleObject(headers: unknown): boolean {
  return headerEntries(headers).some(([name, value]) => name.toLowerCase() === 'accept' && value.includes('vnd.pgrst.object'));
}

function projectRow(row: Row, select: string | null): Row {
  if (select === null || select === '*') return row;
  const columns = select.split(',');
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
}

function noSingleRowError(rowCount: number): InMemorySupabaseResponse {
  return {
    statusCode: 406,
    data: {
      code: 'PGRST116',
      details: `The result contains ${rowCount} rows`,
      hint: null,
      message: 'JSON object requested, multiple (or no) rows returned',
    },
  };
}

/**
 * Registers the in-memory Supabase for the test file that calls it. Every test starts with empty tables.
 */
export function useInMemorySupabase(origin: string): InMemorySupabase {
  let nextRowNumber = 5000;
  let enabled = false;

  const supabase: InMemorySupabase = {
    tables: {},
    requests: [],
    intercept: undefined,
    requestsOf(method: string, table: string) {
      return supabase.requests.filter((request) => request.method === method && request.table === table);
    },
  };

  function table(name: string): Row[] {
    supabase.tables[name] ??= [];
    return supabase.tables[name];
  }

  // The trigger of migration 013
  function queueFileDeletions(deletedRows: Row[]): void {
    const queue = table('crawler_file_deletions');
    for (const row of deletedRows) {
      if (!queue.some((queued) => queued.object_key === row.object_key)) {
        queue.push({ object_key: row.object_key, queued_at: new Date().toISOString() });
      }
    }
  }

  function deleteRows(name: string, predicate: (row: Row) => boolean): Row[] {
    const rows = table(name);
    const deleted = rows.filter(predicate);
    supabase.tables[name] = rows.filter((row) => !predicate(row));
    if (name === 'crawler_files') queueFileDeletions(deleted);
    return deleted;
  }

  function callFunction(name: string, body: Row): InMemorySupabaseResponse {
    if (name === 'delete_expired_crawler_files') {
      const now = Date.now();
      const expired = table('crawler_files')
        .filter((row) => row.expires_at !== null && row.expires_at !== undefined && Date.parse(String(row.expires_at)) <= now)
        .sort((left, right) => compareValues(left.expires_at, right.expires_at))
        .slice(0, Number(body.batch_limit));
      const ids = new Set(expired.map((row) => row.id));
      return { statusCode: 200, data: deleteRows('crawler_files', (row) => ids.has(row.id)).length };
    }
    if (name === 'delete_crawler_file_deletions') {
      const keys = new Set(body.object_keys as string[]);
      return { statusCode: 200, data: deleteRows('crawler_file_deletions', (row) => keys.has(String(row.object_key))).length };
    }
    throw new Error(`In-memory Supabase does not support the function ${name}`);
  }

  function handle(method: string, path: string, rawBody: string, headers: unknown): InMemorySupabaseResponse {
    const url = new URL(path, origin);
    const tableName = url.pathname.replace('/rest/v1/', '');
    const body = rawBody === '' ? undefined : JSON.parse(rawBody) as unknown;
    const request: InMemorySupabaseRequest = { method, table: tableName, query: url.searchParams, body };
    supabase.requests.push(request);

    const intercepted = supabase.intercept?.(request);
    if (intercepted !== undefined) return intercepted;

    if (tableName.startsWith('rpc/')) {
      return callFunction(tableName.slice('rpc/'.length), (body ?? {}) as Row);
    }

    const rows = table(tableName);
    const single = asksForSingleObject(headers);

    if (method === 'GET') {
      const sorted = sortRows(rows.filter((row) => matchesFilters(row, url.searchParams)), url.searchParams.get('order'));
      const limit = url.searchParams.get('limit');
      const matched = (limit === null ? sorted : sorted.slice(0, Number(limit)))
        .map((row) => projectRow(row, url.searchParams.get('select')));
      if (single) {
        return matched.length === 1 ? { statusCode: 200, data: matched[0] } : noSingleRowError(matched.length);
      }
      return { statusCode: 200, data: matched };
    }

    if (method === 'POST') {
      const row: Row = {
        id: `00000000-0000-0000-0000-${String(nextRowNumber++).padStart(12, '0')}`,
        ...TABLE_DEFAULTS[tableName]?.(),
        created_at: new Date().toISOString(),
        ...(body as Row),
      };
      rows.push(row);
      return { statusCode: 201, data: single ? row : [row] };
    }

    if (method === 'PATCH') {
      const matched = rows.filter((row) => matchesFilters(row, url.searchParams));
      if (single && matched.length !== 1) {
        return noSingleRowError(matched.length);
      }
      for (const row of matched) {
        Object.assign(row, body);
      }
      return { statusCode: 200, data: single ? matched[0] : matched };
    }

    if (method === 'DELETE') {
      const deleted = deleteRows(tableName, (row) => matchesFilters(row, url.searchParams));
      return { statusCode: 200, data: deleted.map((row) => projectRow(row, url.searchParams.get('select'))) };
    }

    throw new Error(`In-memory Supabase does not support ${method}`);
  }

  beforeAll(() => {
    enabled = true;
    // Registered once for the file: every handler reads the tables of the current test
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      fetchMock
        .get(origin)
        .intercept({ path: (path: string) => enabled && path.startsWith('/rest/v1/'), method })
        .reply((options) => {
          const { statusCode, data } = handle(method, String(options.path), String(options.body ?? ''), options.headers);
          return { statusCode, data: JSON.stringify(data) };
        })
        .persist();
    }
  });

  beforeEach(() => {
    supabase.tables = {};
    supabase.requests.length = 0;
    supabase.intercept = undefined;
    nextRowNumber = 5000;
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    fetchMock.deactivate();
  });

  afterAll(() => {
    enabled = false;
  });

  return supabase;
}
