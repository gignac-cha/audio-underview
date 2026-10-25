import { beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { network, requestMatching } from '@audio-underview/worker-tools/tests/network.ts';

/**
 * A small in-memory PostgREST behind MSW handlers, for the tests of the pipeline (storage, task
 * group, workflow). It understands what storage.ts sends: eq filters, orders and limits, a
 * maybeSingle read, an update with or without a representation, and an upsert that ignores rows
 * whose `on_conflict` columns are already taken, as the unique (stage_run_id, source_index) does.
 * It serves only the schema the test environment names (SUPABASE_SCHEMA); a request for another one
 * gets the error PostgREST gives.
 */

export type Row = Record<string, unknown>;

export interface InMemorySupabaseRequest {
  method: string;
  table: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
  schema: string;
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

export const SUPABASE_ORIGIN = 'https://supabase.example.com';

// The schema the test environment names (vitest.config.ts)
const servedSchema = (env as unknown as { SUPABASE_SCHEMA: string }).SUPABASE_SCHEMA;

const NON_FILTER_PARAMETERS = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

// Column defaults of the tables rows are inserted into
const TABLE_DEFAULTS: Record<string, () => Row> = {
  newscasts: () => ({
    stage_run_id: null,
    stage_progress: 0,
    overall_progress: 0,
    title: null,
    title_override: null,
    details: {},
    result: null,
    error: null,
    error_code: null,
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
    } else if (operator === 'neq') {
      if (String(value) === operand) return false;
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

// supabase-js names the schema in Accept-Profile on GET and HEAD, and in Content-Profile on the other
// methods. Without the header PostgREST uses its first schema, taken to be public here.
function requestedSchema(method: string, headers: Record<string, string>): string {
  return (method === 'GET' || method === 'HEAD' ? headers['accept-profile'] : headers['content-profile']) ?? 'public';
}

// What PostgREST answers for a schema it does not serve
function schemaNotServedError(served: string): InMemorySupabaseResponse {
  return {
    statusCode: 406,
    data: { code: 'PGRST106', details: null, hint: null, message: `The schema must be one of the following: ${served}` },
  };
}

// .single() asks PostgREST for one object; a list, or a maybeSingle on a GET, asks for an array
function asksForSingleObject(headers: Record<string, string>): boolean {
  return (headers.accept ?? '').includes('vnd.pgrst.object');
}

function asksForRepresentation(headers: Record<string, string>): boolean {
  return (headers.prefer ?? '').includes('return=representation');
}

// Keeps only the requested columns, like PostgREST does for select=a,b
function projectRow(row: Row, select: string | null): Row {
  if (select === null || select === '*') return row;
  const columns = select.split(',');
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
}

/**
 * Registers the in-memory Supabase for the test file that calls it. Every test starts with empty tables.
 */
export function useNewscastsInMemorySupabase(origin: string = SUPABASE_ORIGIN): InMemorySupabase {
  const supabase: InMemorySupabase = {
    tables: {},
    requests: [],
    intercept: undefined,
    requestsOf(method: string, table: string) {
      return supabase.requests.filter((request) => request.method === method && request.table === table);
    },
  };

  function insertRow(table: string, values: Row): Row {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      ...TABLE_DEFAULTS[table]?.(),
      created_at: now,
      updated_at: now,
      ...values,
    };
  }

  function handle(request: InMemorySupabaseRequest): InMemorySupabaseResponse {
    supabase.requests.push(request);
    if (request.schema !== servedSchema) return schemaNotServedError(servedSchema);

    const intercepted = supabase.intercept?.(request);
    if (intercepted !== undefined) return intercepted;

    const { method, table, query, headers } = request;
    supabase.tables[table] ??= [];
    const rows = supabase.tables[table];

    if (method === 'GET') {
      const sorted = sortRows(rows.filter((row) => matchesFilters(row, query)), query.get('order'));
      const limit = query.get('limit');
      const matched = (limit === null ? sorted : sorted.slice(0, Number(limit)))
        .map((row) => projectRow(structuredClone(row), query.get('select')));
      if (asksForSingleObject(headers)) {
        return matched.length === 1
          ? { statusCode: 200, data: matched[0] }
          : { statusCode: 406, data: { code: 'PGRST116', details: `The result contains ${matched.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      return { statusCode: 200, data: matched };
    }

    if (method === 'POST') {
      const values = (Array.isArray(request.body) ? request.body : [request.body]) as Row[];
      const conflictColumns = query.get('on_conflict')?.split(',') ?? [];
      const ignoresDuplicates = (headers.prefer ?? '').includes('resolution=ignore-duplicates');
      const inserted: Row[] = [];
      for (const value of values) {
        const taken = conflictColumns.length > 0 && rows.some((row) =>
          conflictColumns.every((column) => row[column] !== null && row[column] === value[column]));
        if (taken) {
          if (ignoresDuplicates) continue;
          return { statusCode: 409, data: { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint' } };
        }
        const row = insertRow(table, structuredClone(value));
        rows.push(row);
        inserted.push(row);
      }
      return { statusCode: 201, data: asksForRepresentation(headers) ? inserted : [] };
    }

    if (method === 'PATCH') {
      const matched = rows.filter((row) => matchesFilters(row, query));
      for (const row of matched) {
        Object.assign(row, structuredClone(request.body));
      }
      const represented = matched.map((row) => projectRow(structuredClone(row), query.get('select')));
      return { statusCode: 200, data: asksForRepresentation(headers) ? represented : [] };
    }

    throw new Error(`In-memory Supabase does not support ${method}`);
  }

  beforeEach(() => {
    supabase.tables = {};
    supabase.requests.length = 0;
    supabase.intercept = undefined;
    // Handlers are reset after every test, so each test registers them again, ahead of its own
    network.use(...['GET', 'POST', 'PATCH'].map((method) => http.all(
      requestMatching(origin, { path: (path) => path.startsWith('/rest/v1/'), method }),
      async ({ request }) => {
        const url = new URL(request.url);
        const text = await request.text();
        const headers = Object.fromEntries([...request.headers].map(([name, value]) => [name.toLowerCase(), value]));
        const { statusCode, data } = handle({
          method,
          table: url.pathname.replace('/rest/v1/', ''),
          query: url.searchParams,
          body: text === '' ? undefined : JSON.parse(text),
          headers,
          schema: requestedSchema(method, headers),
        });
        return new HttpResponse(JSON.stringify(data), { status: statusCode, headers: { 'content-type': 'application/json' } });
      },
    )));
  });

  return supabase;
}
