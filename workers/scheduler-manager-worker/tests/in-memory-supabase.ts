import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { fetchMock } from 'cloudflare:test';

/**
 * A small in-memory PostgREST behind fetchMock, for tests that follow a flow over several
 * tables. It understands the filters, orders and limits the connector sends, and whether a
 * request asks for one object (.single()) or an array.
 */

export type Row = Record<string, unknown>;

export interface InMemorySupabaseRequest {
  method: string;
  table: string;
  query: URLSearchParams;
  body: Row | undefined;
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
  scheduler_runs: () => ({
    status: 'pending',
    started_at: null,
    completed_at: null,
    result: null,
    error: null,
    triggered_by: 'manual',
    scheduled_for: null,
  }),
  scheduler_stage_runs: () => ({
    status: 'pending',
    started_at: null,
    completed_at: null,
    input: null,
    output: null,
    error: null,
    items_total: null,
    items_succeeded: null,
    items_failed: null,
    task_group_id: null,
    task_group_version: null,
    progress: null,
  }),
};

function matchesFilters(row: Row, query: URLSearchParams): boolean {
  for (const [column, filter] of query) {
    if (NON_FILTER_PARAMETERS.has(column)) continue;
    const separatorIndex = filter.indexOf('.');
    const operator = filter.slice(0, separatorIndex);
    const operand = filter.slice(separatorIndex + 1);
    const value = row[column];
    if (operator === 'eq') {
      if (String(value) !== operand) return false;
    } else if (operator === 'is' && operand === 'null') {
      if (value !== null && value !== undefined) return false;
    } else if (operator === 'not' && operand === 'is.null') {
      if (value === null || value === undefined) return false;
    } else if (operator === 'in') {
      if (!operand.slice(1, -1).split(',').includes(String(value))) return false;
    } else {
      throw new Error(`In-memory Supabase does not support the filter ${column}=${filter}`);
    }
  }
  return true;
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
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

// .single() asks PostgREST for one object; a list, or a maybeSingle on a GET, asks for an array
function asksForSingleObject(headers: unknown): boolean {
  let entries: [string, string][];
  if (headers instanceof Headers) {
    entries = [...headers.entries()];
  } else if (Array.isArray(headers)) {
    entries = [];
    for (let index = 0; index + 1 < headers.length; index += 2) {
      entries.push([String(headers[index]), String(headers[index + 1])]);
    }
  } else {
    entries = Object.entries((headers ?? {}) as Record<string, string>);
  }
  return entries.some(([name, value]) => name.toLowerCase() === 'accept' && value.includes('vnd.pgrst.object'));
}

// Keeps only the requested columns, like PostgREST does for select=a,b
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
  // The interceptors persist, so they match only while this file runs
  let enabled = false;

  const supabase: InMemorySupabase = {
    tables: {},
    requests: [],
    intercept: undefined,
    requestsOf(method: string, table: string) {
      return supabase.requests.filter((request) => request.method === method && request.table === table);
    },
  };

  function handle(method: string, path: string, rawBody: string, headers: unknown): InMemorySupabaseResponse {
    const url = new URL(path, origin);
    const table = url.pathname.replace('/rest/v1/', '');
    const body = rawBody === '' ? undefined : JSON.parse(rawBody) as Row;
    const request: InMemorySupabaseRequest = { method, table, query: url.searchParams, body };
    supabase.requests.push(request);

    const intercepted = supabase.intercept?.(request);
    if (intercepted !== undefined) return intercepted;

    supabase.tables[table] ??= [];
    const rows = supabase.tables[table];
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
        ...TABLE_DEFAULTS[table]?.(),
        created_at: new Date().toISOString(),
        ...body,
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

    throw new Error(`In-memory Supabase does not support ${method}`);
  }

  beforeAll(() => {
    enabled = true;
    // Registered once for the file: every handler reads the tables of the current test
    for (const method of ['GET', 'POST', 'PATCH']) {
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
