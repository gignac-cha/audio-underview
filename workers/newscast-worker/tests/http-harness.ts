import { beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { http, HttpResponse } from 'msw';
import { network, requestMatching } from '@audio-underview/worker-tools/tests/network.ts';
import { signJWT } from '@audio-underview/worker-tools';

/**
 * What the route tests share: an in-memory PostgREST for `newscasts`, `newscast_shares` and the tables the
 * templates read (`newscast_schedulers`, `crawlers`, `crawler_permissions`) behind MSW handlers, newscast and
 * share rows shaped as migration 016 makes them, session JWTs, and the audio bucket.
 */

export const SUPABASE_ORIGIN = 'https://supabase.example.com';
export const ALLOWED_ORIGIN = 'https://example.com';
export const WORKER_ORIGIN = 'https://newscast-worker.example.com';

const testEnvironment = env as unknown as {
  JWT_SECRET: string;
  SUPABASE_SCHEMA: string;
  NEWSCAST_AUDIO: R2Bucket;
};

export const JWT_SECRET = testEnvironment.JWT_SECRET;
export const NEWSCAST_AUDIO = testEnvironment.NEWSCAST_AUDIO;

export type Row = Record<string, unknown>;

export interface InMemorySupabaseRequest {
  method: string;
  table: string;
  query: URLSearchParams;
  body: unknown;
  schema: string;
}

interface InMemorySupabaseResponse {
  statusCode: number;
  data: unknown;
  headers?: Record<string, string>;
}

export interface InMemorySupabase {
  tables: Record<string, Row[]>;
  requests: InMemorySupabaseRequest[];
  /** Runs before the tables answer; returning a response answers instead, for example with an error */
  intercept: ((request: InMemorySupabaseRequest) => InMemorySupabaseResponse | undefined) | undefined;
  requestsOf(method: string, table: string): InMemorySupabaseRequest[];
}

const NON_FILTER_PARAMETERS = new Set(['select', 'order', 'limit', 'offset', 'columns']);

// Column defaults of migration 016
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
    updated_at: new Date().toISOString(),
  }),
  newscast_shares: () => ({ included_metadata: {} }),
};

// The tables whose rows get an `id` from the database when they are inserted
const TABLES_WITH_GENERATED_ID = new Set(['newscasts', 'crawler_permissions']);

// The PRIMARY KEY and UNIQUE columns of migration 016 that the tests write
const UNIQUE_COLUMNS: Record<string, string[]> = {
  newscasts: ['id'],
  newscast_shares: ['token', 'newscast_id'],
};

function uniqueViolation(table: string, column: string): InMemorySupabaseResponse {
  return {
    statusCode: 409,
    data: { code: '23505', details: null, hint: null, message: `duplicate key value violates unique constraint "${table}_${column}_key"` },
  };
}

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
    case 'neq':
      return value !== null && value !== undefined && String(value) !== operand;
    case 'is':
      if (operand !== 'null') throw new Error(`In-memory Supabase does not support is.${operand}`);
      return value === null || value === undefined;
    case 'in':
      return operand.slice(1, -1).split(',').includes(String(value));
    default:
      throw new Error(`In-memory Supabase does not support the filter ${column}=${filter}`);
  }
}

function matchesFilters(row: Row, query: URLSearchParams): boolean {
  for (const [column, filter] of query) {
    if (NON_FILTER_PARAMETERS.has(column)) continue;
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

// supabase-js names the schema in Accept-Profile on GET and HEAD, and in Content-Profile on the other methods
function requestedSchema(method: string, headers: Headers): string {
  return headers.get(method === 'GET' || method === 'HEAD' ? 'accept-profile' : 'content-profile') ?? 'public';
}

// .single() asks PostgREST for one object; a list, or a maybeSingle on a GET, asks for an array
function asksForSingleObject(headers: Headers): boolean {
  return (headers.get('accept') ?? '').includes('vnd.pgrst.object');
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
 * It serves only the schema the test environment names, as the real project serves only exposed ones.
 */
export function useInMemorySupabase(): InMemorySupabase {
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

  function handle(method: string, url: URL, rawBody: string, headers: Headers): InMemorySupabaseResponse {
    const tableName = url.pathname.replace('/rest/v1/', '');
    const body = rawBody === '' ? undefined : JSON.parse(rawBody) as unknown;
    const request: InMemorySupabaseRequest = { method, table: tableName, query: url.searchParams, body, schema: requestedSchema(method, headers) };
    supabase.requests.push(request);
    if (request.schema !== testEnvironment.SUPABASE_SCHEMA) {
      return {
        statusCode: 406,
        data: { code: 'PGRST106', details: null, hint: null, message: `The schema must be one of the following: ${testEnvironment.SUPABASE_SCHEMA}` },
      };
    }

    const intercepted = supabase.intercept?.(request);
    if (intercepted !== undefined) return intercepted;

    const rows = table(tableName);
    const single = asksForSingleObject(headers);
    const select = url.searchParams.get('select');

    if (method === 'GET') {
      const sorted = sortRows(rows.filter((row) => matchesFilters(row, url.searchParams)), url.searchParams.get('order'));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = url.searchParams.get('limit');
      const matched = sorted.slice(offset, limit === null ? undefined : offset + Number(limit)).map((row) => projectRow(row, select));
      if (single) {
        return matched.length === 1 ? { statusCode: 200, data: matched[0] } : noSingleRowError(matched.length);
      }
      return { statusCode: 200, data: matched };
    }

    if (method === 'POST') {
      const row: Row = {
        ...(TABLES_WITH_GENERATED_ID.has(tableName) ? { id: crypto.randomUUID() } : {}),
        ...TABLE_DEFAULTS[tableName]?.(),
        created_at: new Date().toISOString(),
        ...(body as Row),
      };
      // An upsert names the columns that decide whether the row is taken; it ignores the new row or merges it
      const conflictColumns = url.searchParams.get('on_conflict')?.split(',');
      const taken = conflictColumns === undefined ? undefined : rows.find((existing) => conflictColumns.every((column) => existing[column] === row[column]));
      if (taken !== undefined) {
        if (!(headers.get('prefer') ?? '').includes('resolution=merge-duplicates')) return { statusCode: 201, data: [] };
        Object.assign(taken, body);
        return { statusCode: 201, data: single ? projectRow(taken, select) : [projectRow(taken, select)] };
      }
      for (const column of UNIQUE_COLUMNS[tableName] ?? []) {
        if (rows.some((existing) => existing[column] === row[column])) return uniqueViolation(tableName, column);
      }
      rows.push(row);
      return { statusCode: 201, data: single ? projectRow(row, select) : [projectRow(row, select)] };
    }

    if (method === 'PATCH') {
      const matched = rows.filter((row) => matchesFilters(row, url.searchParams));
      if (single && matched.length !== 1) return noSingleRowError(matched.length);
      for (const column of UNIQUE_COLUMNS[tableName] ?? []) {
        const value = (body as Row)[column];
        if (value !== undefined && rows.some((existing) => !matched.includes(existing) && existing[column] === value)) {
          return uniqueViolation(tableName, column);
        }
      }
      for (const row of matched) Object.assign(row, body);
      const projected = matched.map((row) => projectRow(row, select));
      return { statusCode: 200, data: single ? projected[0] : projected };
    }

    if (method === 'DELETE') {
      const deleted = rows.filter((row) => matchesFilters(row, url.searchParams));
      supabase.tables[tableName] = rows.filter((row) => !deleted.includes(row));
      return { statusCode: 200, data: deleted.map((row) => projectRow(row, select)) };
    }

    throw new Error(`In-memory Supabase does not support ${method}`);
  }

  beforeEach(() => {
    supabase.tables = {};
    supabase.requests.length = 0;
    supabase.intercept = undefined;
    // Handlers are reset after every test, so each test registers them again, ahead of its own
    network.use(...['GET', 'POST', 'PATCH', 'DELETE'].map((method) => http.all(
      requestMatching(SUPABASE_ORIGIN, { path: (path) => path.startsWith('/rest/v1/'), method }),
      async ({ request }) => {
        const { statusCode, data, headers } = handle(method, new URL(request.url), await request.text(), request.headers);
        return new HttpResponse(JSON.stringify(data), { status: statusCode, headers: { 'content-type': 'application/json', ...headers } });
      },
    )));
  });

  return supabase;
}

/** A UUID unique to the test */
export function uniqueUUID(): string {
  return crypto.randomUUID();
}

/** A `newscasts` row as migration 016 makes it, done by default, with a result of two parts and a signal */
export function newscastRow(overrides: Row = {}): Row {
  const id = (overrides.id as string | undefined) ?? uniqueUUID();
  return {
    id,
    user_uuid: uniqueUUID(),
    stage_run_id: uniqueUUID(),
    source_index: 0,
    status: 'done',
    stage: 'done',
    stage_progress: 1,
    overall_progress: 1,
    title: '이해가 새로운 병목이다',
    title_override: null,
    // The NewscastRequest of environment.ts: the source and the settings
    request: {
      limit: 1,
      customArticle: { title: '붙여넣은 기사', content: 'SECRET-CUSTOM-ARTICLE-BODY' },
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      effort: 'high',
      lengthPreference: 'standard',
      ttsModel: 'gemini-2.5-flash-preview-tts',
      speaker1Voice: 'Charon',
      speaker2Voice: 'Leda',
      signal: true,
    },
    details: {
      scriptRequest: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'high' },
      failure: { stage: 'script', message: 'SECRET-FAILURE-MESSAGE', at: '2026-10-26T00:00:00.000Z' },
    },
    result: {
      sources: [
        {
          title: '이해가 새로운 병목이다',
          originalUrl: 'https://example.com/article',
          discussionUrl: 'https://news.hada.io/topic?id=1',
          content: 'SECRET-ARTICLE-BODY',
        },
      ],
      script: [{ speaker: 1, text: '안녕하세요.' }],
      segments: [{ index: 0, startMs: 0, durationMs: 4_200 }],
      audioKey: `${id}/part-1`,
      parts: [
        {
          index: 1,
          audioKey: `${id}/part-1`,
          script: [{ speaker: 1, text: '안녕하세요.' }],
          segments: [{ index: 0, startMs: 0, durationMs: 4_200, words: [{ text: '안녕하세요.', startMs: 0, endMs: 900 }] }],
          durationMs: 180_000,
        },
        {
          index: 2,
          audioKey: `${id}/part-2`,
          script: [{ speaker: 2, text: '반갑습니다.' }],
          segments: [{ index: 0, startMs: 0, durationMs: 5_000 }],
          durationMs: 120_000,
        },
      ],
      signalAudioKey: `${id}/signal`,
    },
    error: null,
    error_code: null,
    created_at: '2026-10-26T09:30:00.000Z',
    updated_at: '2026-10-26T09:40:00.000Z',
    ...overrides,
  };
}

export function addRow(supabase: InMemorySupabase, tableName: string, row: Row): Row {
  supabase.tables[tableName] ??= [];
  supabase.tables[tableName].push(row);
  return row;
}

/** A session JWT of the main login, as crawler-manager-worker issues it */
export async function sessionToken(userUUID: string, claims: Record<string, unknown> = {}, secret = JWT_SECRET): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ sub: userUUID, iat: now, exp: now + 3600, ...claims }, secret);
}

export interface WorkerRequestOptions {
  method?: string;
  /** Signs a session for the user; null sends no Authorization header */
  userUUID?: string | null;
  /** Sent as the Authorization header as it is */
  authorization?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Sends a request to the worker under test */
export async function fetchWorker(path: string, options: WorkerRequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.authorization !== undefined) {
    headers.Authorization = options.authorization;
  } else if (options.userUUID !== undefined && options.userUUID !== null) {
    headers.Authorization = `Bearer ${await sessionToken(options.userUUID)}`;
  }
  return SELF.fetch(`${WORKER_ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
}

/** Stores audio bytes the way the audio stage does */
export async function putAudio(key: string, bytes: number[]): Promise<void> {
  await NEWSCAST_AUDIO.put(key, new Uint8Array(bytes), { httpMetadata: { contentType: 'audio/mpeg' } });
}
