/**
 * A small in-memory PostgREST standing in for Supabase in the vault tests, behind the global fetch they stub.
 * It holds the three tables of migration 015 and its insert_environment_variable function, and understands
 * exactly the requests storage.ts sends: eq filters, select, order and limit, an upsert on its conflict target,
 * and return=representation. Anything else throws, so a changed request shows up as a test failure. Like
 * Postgres it refuses a user_id that is not a uuid, and like PostgREST it serves only one schema
 * (SUPABASE_SCHEMA): a request for another one gets the error PostgREST gives.
 */

export const SUPABASE_URL = 'https://supabase.example.com';
export const SUPABASE_SCHEMA = 'test_schema';

/** The Supabase part of the vault environment the tests pass */
export const SUPABASE_ENVIRONMENT = {
  SUPABASE_URL,
  SUPABASE_SCHEMA,
  SUPABASE_SECRET_KEY: 'test-secret-key',
};

export interface InMemoryProviderKeyRow {
  user_id: string;
  provider: string;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  dek_iv: string;
  key_version: number;
  last4: string;
  created_at: string;
  validated_at: string | null;
}

export interface InMemoryEnvironmentVariableRow {
  user_id: string;
  name: string;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  dek_iv: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface InMemoryAuditRow {
  id: number;
  user_id: string;
  provider: string;
  action: string;
  at: string;
  ip_hash: string | null;
  ua_hash: string | null;
}

export type InMemoryTableName = 'provider_keys' | 'key_audit_log' | 'environment_variables';

export interface InMemorySupabaseRequest {
  method: string;
  /** The table, or rpc/<function> */
  table: string;
  query: URLSearchParams;
  body: unknown;
  schema: string;
}

type Row = Record<string, unknown>;

interface Answer {
  status: number;
  data?: unknown;
}

interface TableDefinition {
  columns: readonly string[];
  primaryKey: readonly string[];
  nullable: readonly string[];
  /** Columns a row may leave out, with the value Postgres gives them */
  defaults: Row;
}

const TABLES: Record<InMemoryTableName, TableDefinition> = {
  provider_keys: {
    columns: ['user_id', 'provider', 'ciphertext', 'iv', 'wrapped_dek', 'dek_iv', 'key_version', 'last4', 'created_at', 'validated_at'],
    primaryKey: ['user_id', 'provider'],
    nullable: ['validated_at'],
    defaults: { key_version: 1, validated_at: null },
  },
  key_audit_log: {
    columns: ['id', 'user_id', 'provider', 'action', 'at', 'ip_hash', 'ua_hash'],
    primaryKey: ['id'],
    nullable: ['ip_hash', 'ua_hash'],
    defaults: { ip_hash: null, ua_hash: null },
  },
  environment_variables: {
    columns: ['user_id', 'name', 'ciphertext', 'iv', 'wrapped_dek', 'dek_iv', 'key_version', 'created_at', 'updated_at'],
    primaryKey: ['user_id', 'name'],
    nullable: [],
    defaults: { key_version: 1 },
  },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTableName(name: string): name is InMemoryTableName {
  return Object.hasOwn(TABLES, name);
}

function error(status: number, code: string, message: string): Answer {
  return { status, data: { code, details: null, hint: null, message } };
}

// What Postgres answers for a user_id that is not a uuid, before any row is read or written
function invalidUserID(value: unknown): Answer | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? undefined : error(400, '22P02', `invalid input syntax for type uuid: "${String(value)}"`);
}

// Names and times are ASCII here, so comparing UTF-16 code units is the byte order of COLLATE "C"
function compareValues(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function headerValues(headers: Headers, name: string): string[] {
  return (headers.get(name) ?? '').split(',').map((value) => value.trim());
}

export class InMemorySupabase {
  providerKeys: InMemoryProviderKeyRow[] = [];
  environmentVariables: InMemoryEnvironmentVariableRow[] = [];
  auditLog: InMemoryAuditRow[] = [];
  /** Every request in the order it arrived, also those answered with an error */
  requests: InMemorySupabaseRequest[] = [];
  /** Tables answered as missing, for the failure paths */
  brokenTables = new Set<InMemoryTableName>();
  /** Runs right before a request is answered, to change the tables as a concurrent writer would */
  beforeRequest: ((request: InMemorySupabaseRequest) => void) | null = null;
  private nextAuditID = 1;

  /** Whether the request goes to this Supabase */
  serves(input: RequestInfo | URL): boolean {
    const url = input instanceof Request ? input.url : String(input);
    return new URL(url).origin === SUPABASE_URL;
  }

  /** A fetch that answers the requests storage.ts sends, to stub the global fetch with */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== SUPABASE_URL || !url.pathname.startsWith('/rest/v1/')) {
      throw new Error(`In-memory Supabase does not serve ${request.method} ${request.url}`);
    }
    const text = await request.text();
    const recorded: InMemorySupabaseRequest = {
      method: request.method,
      table: url.pathname.slice('/rest/v1/'.length),
      query: url.searchParams,
      body: text === '' ? undefined : JSON.parse(text),
      // supabase-js names the schema in Accept-Profile on GET and HEAD and in Content-Profile on the other
      // methods. Without the header PostgREST serves its first schema, public.
      schema: request.headers.get(request.method === 'GET' || request.method === 'HEAD' ? 'accept-profile' : 'content-profile') ?? 'public',
    };
    this.requests.push(recorded);

    const answer = this.answer(recorded, request.headers);
    if (answer.data === undefined) {
      return new Response(null, { status: answer.status });
    }
    return new Response(JSON.stringify(answer.data), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };

  requestsOf(method: string, table: string): InMemorySupabaseRequest[] {
    return this.requests.filter((request) => request.method === method && request.table === table);
  }

  /** Inserts an audit row directly, bypassing storage.ts */
  insertAuditRow(row: Omit<InMemoryAuditRow, 'id'>): void {
    this.auditLog.push({ id: this.nextAuditID, ...row });
    this.nextAuditID += 1;
  }

  private rows(table: InMemoryTableName): Row[] {
    switch (table) {
      case 'provider_keys':
        return this.providerKeys as unknown as Row[];
      case 'key_audit_log':
        return this.auditLog as unknown as Row[];
      case 'environment_variables':
        return this.environmentVariables as unknown as Row[];
    }
  }

  private setRows(table: InMemoryTableName, rows: Row[]): void {
    switch (table) {
      case 'provider_keys':
        this.providerKeys = rows as unknown as InMemoryProviderKeyRow[];
        break;
      case 'key_audit_log':
        this.auditLog = rows as unknown as InMemoryAuditRow[];
        break;
      case 'environment_variables':
        this.environmentVariables = rows as unknown as InMemoryEnvironmentVariableRow[];
        break;
    }
  }

  private answer(request: InMemorySupabaseRequest, headers: Headers): Answer {
    if (request.schema !== SUPABASE_SCHEMA) {
      return error(406, 'PGRST106', `The schema must be one of the following: ${SUPABASE_SCHEMA}`);
    }
    this.beforeRequest?.(request);

    if (request.table === 'rpc/insert_environment_variable' && request.method === 'POST') {
      return this.insertEnvironmentVariable(request.body as Row);
    }
    if (!isTableName(request.table)) {
      throw new Error(`In-memory Supabase does not support ${request.method} ${request.table}`);
    }
    const table = request.table;
    if (this.brokenTables.has(table)) {
      return error(404, 'PGRST205', `Could not find the table '${SUPABASE_SCHEMA}.${table}' in the schema cache`);
    }

    const filters = this.readFilters(table, request.query);
    if (filters.user_id !== undefined) {
      const refused = invalidUserID(filters.user_id);
      if (refused !== undefined) return refused;
    }
    const matches = (row: Row) => Object.entries(filters).every(([column, value]) => String(row[column]) === value);
    const select = request.query.get('select');
    const representation = headerValues(headers, 'prefer').includes('return=representation');

    switch (request.method) {
      case 'GET': {
        if (headerValues(headers, 'accept').some((value) => value.includes('vnd.pgrst.object'))) {
          throw new Error('In-memory Supabase does not support single object responses');
        }
        let rows = this.rows(table).filter(matches);
        const order = request.query.get('order');
        if (order !== null) {
          const [column, direction] = order.split('.');
          this.requireColumns(table, [column]);
          rows = [...rows].sort((left, right) => compareValues(left[column], right[column]) * (direction === 'desc' ? -1 : 1));
        }
        const limit = request.query.get('limit');
        if (limit !== null) rows = rows.slice(0, Number(limit));
        return { status: 200, data: rows.map((row) => this.project(table, row, select)) };
      }
      case 'POST':
        return this.insert(table, request, headers, representation);
      case 'PATCH': {
        const changes = request.body as Row;
        this.requireColumns(table, Object.keys(changes));
        const rows = this.rows(table).filter(matches);
        for (const row of rows) Object.assign(row, changes);
        return representation ? { status: 200, data: rows.map((row) => this.project(table, row, select)) } : { status: 204 };
      }
      case 'DELETE': {
        const removed = this.rows(table).filter(matches);
        this.setRows(table, this.rows(table).filter((row) => !matches(row)));
        return representation ? { status: 200, data: removed.map((row) => this.project(table, row, select)) } : { status: 204 };
      }
      default:
        throw new Error(`In-memory Supabase does not support ${request.method}`);
    }
  }

  // Only `<column>=eq.<value>` filters, next to select, order, limit and on_conflict
  private readFilters(table: InMemoryTableName, query: URLSearchParams): Record<string, string> {
    const filters: Record<string, string> = {};
    for (const [name, value] of query) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(name)) continue;
      if (!value.startsWith('eq.')) {
        throw new Error(`In-memory Supabase does not support the filter ${name}=${value}`);
      }
      this.requireColumns(table, [name]);
      filters[name] = value.slice('eq.'.length);
    }
    return filters;
  }

  private requireColumns(table: InMemoryTableName, columns: string[]): void {
    for (const column of columns) {
      if (!TABLES[table].columns.includes(column)) {
        throw new Error(`In-memory Supabase: ${table} has no column ${column}`);
      }
    }
  }

  private project(table: InMemoryTableName, row: Row, select: string | null): Row {
    if (select === null || select === '*') {
      throw new Error(`In-memory Supabase: a request reads ${table} without listing its columns`);
    }
    const columns = select.split(',');
    this.requireColumns(table, columns);
    return Object.fromEntries(columns.map((column) => [column, row[column]]));
  }

  private insert(table: InMemoryTableName, request: InMemorySupabaseRequest, headers: Headers, representation: boolean): Answer {
    if (Array.isArray(request.body)) {
      throw new Error('In-memory Supabase does not support inserting several rows');
    }
    const values = request.body as Row;
    this.requireColumns(table, Object.keys(values));
    const refused = invalidUserID(values.user_id);
    if (refused !== undefined) return refused;

    const definition = TABLES[table];
    const row: Row = { ...definition.defaults, ...values };
    if (table === 'key_audit_log') {
      if ('id' in values) return error(400, '428C9', 'cannot insert a non-DEFAULT value into column "id"');
      row.id = this.nextAuditID;
      this.nextAuditID += 1;
    }
    for (const column of definition.columns) {
      if (row[column] === undefined || (row[column] === null && !definition.nullable.includes(column))) {
        return error(400, '23502', `null value in column "${column}" of relation "${table}" violates not-null constraint`);
      }
    }

    const rows = this.rows(table);
    const existing = rows.find((candidate) => definition.primaryKey.every((column) => candidate[column] === row[column]));
    if (existing !== undefined) {
      const resolution = headerValues(headers, 'prefer').find((value) => value.startsWith('resolution='));
      if (resolution !== 'resolution=merge-duplicates' || request.query.get('on_conflict') !== definition.primaryKey.join(',')) {
        return error(409, '23505', `duplicate key value violates unique constraint "${table}_pkey"`);
      }
      Object.assign(existing, values);
      return representation ? { status: 200, data: [this.project(table, existing, request.query.get('select'))] } : { status: 201 };
    }
    rows.push(row);
    return representation ? { status: 201, data: [this.project(table, row, request.query.get('select'))] } : { status: 201 };
  }

  // The function of migration 015
  private insertEnvironmentVariable(body: Row): Answer {
    const variable = body.variable as Row;
    const maximumCount = body.maximum_count as number;
    const refused = invalidUserID(variable.user_id);
    if (refused !== undefined) return refused;
    if (this.brokenTables.has('environment_variables')) {
      return error(404, 'PGRST205', `Could not find the table '${SUPABASE_SCHEMA}.environment_variables' in the schema cache`);
    }
    const ofUser = this.environmentVariables.filter((row) => row.user_id === variable.user_id);
    if (ofUser.length >= maximumCount || ofUser.some((row) => row.name === variable.name)) {
      return { status: 200, data: false };
    }
    const row: Row = { ...TABLES.environment_variables.defaults, ...variable };
    this.requireColumns('environment_variables', Object.keys(row));
    this.environmentVariables.push(row as unknown as InMemoryEnvironmentVariableRow);
    return { status: 200, data: true };
  }
}
