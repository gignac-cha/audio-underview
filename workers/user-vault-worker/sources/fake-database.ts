/**
 * In-memory fake of the D1 surface that storage.ts uses. Only the *.test.ts
 * files import it; it understands exactly the statements storage.ts sends and
 * throws on anything else, so a changed statement shows up as a test failure.
 */

export interface FakeProviderKeyRow {
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

export interface FakeAuditRow {
  id: number;
  user_id: string;
  provider: string;
  action: string;
  at: string;
  ip_hash: string | null;
  ua_hash: string | null;
}

export interface ExecutedStatement {
  sql: string;
  values: unknown[];
}

type FakeTableName = 'provider_keys' | 'key_audit_log';

interface StatementResult {
  rows: Record<string, unknown>[];
  changes: number;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

const PROVIDER_KEY_COLUMNS = [
  'provider',
  'ciphertext',
  'iv',
  'wrapped_dek',
  'dek_iv',
  'key_version',
  'last4',
  'created_at',
  'validated_at',
] as const;

const STATEMENTS = {
  selectProviderKey: normalize(
    `SELECT ${PROVIDER_KEY_COLUMNS.join(', ')} FROM provider_keys WHERE user_id = ? AND provider = ?`,
  ),
  selectProviderKeys: normalize(`SELECT ${PROVIDER_KEY_COLUMNS.join(', ')} FROM provider_keys WHERE user_id = ?`),
  upsertProviderKey: normalize(`INSERT INTO provider_keys (user_id, provider, ciphertext, iv, wrapped_dek, dek_iv, key_version, last4, created_at, validated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, provider) DO UPDATE SET
      ciphertext = excluded.ciphertext, iv = excluded.iv, wrapped_dek = excluded.wrapped_dek, dek_iv = excluded.dek_iv,
      key_version = excluded.key_version, last4 = excluded.last4, created_at = excluded.created_at, validated_at = excluded.validated_at`),
  deleteProviderKey: normalize('DELETE FROM provider_keys WHERE user_id = ? AND provider = ?'),
  replaceWrappedDataEncryptionKey: normalize(
    'UPDATE provider_keys SET wrapped_dek = ?, dek_iv = ? WHERE user_id = ? AND provider = ? AND wrapped_dek = ?',
  ),
  insertAuditEvent: normalize(
    'INSERT INTO key_audit_log (user_id, provider, action, at, ip_hash, ua_hash) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  selectAuditEvents: normalize(
    'SELECT provider, action, at FROM key_audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
  ),
};

function pickProviderKeyColumns(row: FakeProviderKeyRow): Record<string, unknown> {
  return Object.fromEntries(PROVIDER_KEY_COLUMNS.map((column) => [column, row[column]]));
}

export class FakeDatabase {
  providerKeys: FakeProviderKeyRow[] = [];
  auditLog: FakeAuditRow[] = [];
  executedStatements: ExecutedStatement[] = [];
  brokenTables = new Set<FakeTableName>();
  private nextAuditID = 1;

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql, []);
  }

  asD1Database(): D1Database {
    return this as unknown as D1Database;
  }

  execute(sql: string, values: unknown[]): StatementResult {
    const statement = normalize(sql);
    this.executedStatements.push({ sql: statement, values });

    for (const table of this.brokenTables) {
      if (statement.includes(table)) {
        throw new Error(`D1_ERROR: no such table: ${table}`);
      }
    }

    switch (statement) {
      case STATEMENTS.selectProviderKey: {
        const [userID, provider] = values;
        const rows = this.providerKeys
          .filter((row) => row.user_id === userID && row.provider === provider)
          .map(pickProviderKeyColumns);
        return { rows, changes: 0 };
      }
      case STATEMENTS.selectProviderKeys: {
        const [userID] = values;
        const rows = this.providerKeys.filter((row) => row.user_id === userID).map(pickProviderKeyColumns);
        return { rows, changes: 0 };
      }
      case STATEMENTS.upsertProviderKey: {
        const [userID, provider, ciphertext, initializationVector, wrappedKey, keyInitializationVector, keyVersion, last4, createdAt, validatedAt] =
          values as [string, string, string, string, string, string, number, string, string, string | null];
        const replacement: FakeProviderKeyRow = {
          user_id: userID,
          provider,
          ciphertext,
          iv: initializationVector,
          wrapped_dek: wrappedKey,
          dek_iv: keyInitializationVector,
          key_version: keyVersion,
          last4,
          created_at: createdAt,
          validated_at: validatedAt,
        };
        const index = this.providerKeys.findIndex((row) => row.user_id === userID && row.provider === provider);
        if (index === -1) {
          this.providerKeys.push(replacement);
        } else {
          this.providerKeys[index] = replacement;
        }
        return { rows: [], changes: 1 };
      }
      case STATEMENTS.deleteProviderKey: {
        const [userID, provider] = values;
        const before = this.providerKeys.length;
        this.providerKeys = this.providerKeys.filter((row) => !(row.user_id === userID && row.provider === provider));
        return { rows: [], changes: before - this.providerKeys.length };
      }
      case STATEMENTS.replaceWrappedDataEncryptionKey: {
        const [wrappedKey, keyInitializationVector, userID, provider, previousWrappedKey] = values as string[];
        let changes = 0;
        for (const row of this.providerKeys) {
          if (row.user_id === userID && row.provider === provider && row.wrapped_dek === previousWrappedKey) {
            row.wrapped_dek = wrappedKey as string;
            row.dek_iv = keyInitializationVector as string;
            changes += 1;
          }
        }
        return { rows: [], changes };
      }
      case STATEMENTS.insertAuditEvent: {
        const [userID, provider, action, at, ipHash, userAgentHash] = values as [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
        ];
        this.auditLog.push({
          id: this.nextAuditID,
          user_id: userID,
          provider,
          action,
          at,
          ip_hash: ipHash,
          ua_hash: userAgentHash,
        });
        this.nextAuditID += 1;
        return { rows: [], changes: 1 };
      }
      case STATEMENTS.selectAuditEvents: {
        const [userID, limit] = values as [string, number];
        const rows = this.auditLog
          .filter((row) => row.user_id === userID)
          .sort((left, right) => right.id - left.id)
          .slice(0, limit)
          .map((row) => ({ provider: row.provider, action: row.action, at: row.at }));
        return { rows, changes: 0 };
      }
      default:
        throw new Error(`Unexpected statement: ${statement}`);
    }
  }

  /** Test helper: inserts an audit row directly, bypassing storage.ts. */
  insertAuditRow(row: Omit<FakeAuditRow, 'id'>): void {
    this.auditLog.push({ id: this.nextAuditID, ...row });
    this.nextAuditID += 1;
  }
}

export class FakePreparedStatement {
  private readonly database: FakeDatabase;
  private readonly sql: string;
  private readonly values: unknown[];

  constructor(database: FakeDatabase, sql: string, values: unknown[]) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): FakePreparedStatement {
    for (const value of values) {
      if (value === undefined) {
        throw new Error('D1_TYPE_ERROR: Type undefined is not supported');
      }
    }
    return new FakePreparedStatement(this.database, this.sql, values);
  }

  async first<Row = Record<string, unknown>>(): Promise<Row | null> {
    const result = this.database.execute(this.sql, this.values);
    return (result.rows[0] as Row | undefined) ?? null;
  }

  async all<Row = Record<string, unknown>>(): Promise<{ results: Row[]; success: true; meta: { changes: number } }> {
    const result = this.database.execute(this.sql, this.values);
    return { results: result.rows as Row[], success: true, meta: { changes: result.changes } };
  }

  async run(): Promise<{ results: []; success: true; meta: { changes: number } }> {
    const result = this.database.execute(this.sql, this.values);
    return { results: [], success: true, meta: { changes: result.changes } };
  }
}
