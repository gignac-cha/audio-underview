import { isAuditAction, type AuditAction } from './audit.ts';
import type { WrappedDataEncryptionKey } from './envelope.ts';
import { isProviderName, type ProviderName } from './providers.ts';

export interface ProviderKeyRecord {
  provider: ProviderName;
  ciphertext: string;
  initializationVector: string;
  wrappedDataEncryptionKey: string;
  dataEncryptionKeyInitializationVector: string;
  keyVersion: number;
  last4: string;
  createdAt: string;
  validatedAt: string | null;
}

export interface AuditEventRecord {
  provider: ProviderName;
  action: AuditAction;
  at: string;
}

export interface NewAuditEvent extends AuditEventRecord {
  ipHash: string | null;
  userAgentHash: string | null;
}

/**
 * Every operation is bound to the userID the storage was created for.
 */
export interface UserVaultStorage {
  readonly userID: string;
  readProviderKey(provider: ProviderName): Promise<ProviderKeyRecord | null>;
  listProviderKeys(): Promise<ProviderKeyRecord[]>;
  writeProviderKey(record: ProviderKeyRecord): Promise<void>;
  deleteProviderKey(provider: ProviderName): Promise<boolean>;
  replaceWrappedDataEncryptionKey(
    provider: ProviderName,
    previousWrappedDataEncryptionKey: string,
    replacement: WrappedDataEncryptionKey,
  ): Promise<boolean>;
  appendAuditEvent(event: NewAuditEvent): Promise<void>;
  listAuditEvents(limit: number): Promise<AuditEventRecord[]>;
}

export const AUDIT_EVENT_LIMIT_MINIMUM = 1;
export const AUDIT_EVENT_LIMIT_MAXIMUM = 200;

const PROVIDER_KEY_COLUMNS =
  'provider, ciphertext, iv, wrapped_dek, dek_iv, key_version, last4, created_at, validated_at';

const SELECT_PROVIDER_KEY_STATEMENT = `SELECT ${PROVIDER_KEY_COLUMNS} FROM provider_keys WHERE user_id = ? AND provider = ?`;

const SELECT_PROVIDER_KEYS_STATEMENT = `SELECT ${PROVIDER_KEY_COLUMNS} FROM provider_keys WHERE user_id = ?`;

const UPSERT_PROVIDER_KEY_STATEMENT = `INSERT INTO provider_keys (user_id, provider, ciphertext, iv, wrapped_dek, dek_iv, key_version, last4, created_at, validated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, provider) DO UPDATE SET
  ciphertext = excluded.ciphertext,
  iv = excluded.iv,
  wrapped_dek = excluded.wrapped_dek,
  dek_iv = excluded.dek_iv,
  key_version = excluded.key_version,
  last4 = excluded.last4,
  created_at = excluded.created_at,
  validated_at = excluded.validated_at`;

const DELETE_PROVIDER_KEY_STATEMENT = 'DELETE FROM provider_keys WHERE user_id = ? AND provider = ?';

// The wrapped_dek condition keeps a rewrap from overwriting a row that a
// concurrent put has already replaced with a new envelope.
const REPLACE_WRAPPED_DATA_ENCRYPTION_KEY_STATEMENT =
  'UPDATE provider_keys SET wrapped_dek = ?, dek_iv = ? WHERE user_id = ? AND provider = ? AND wrapped_dek = ?';

const INSERT_AUDIT_EVENT_STATEMENT =
  'INSERT INTO key_audit_log (user_id, provider, action, at, ip_hash, ua_hash) VALUES (?, ?, ?, ?, ?, ?)';

const SELECT_AUDIT_EVENTS_STATEMENT =
  'SELECT provider, action, at FROM key_audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?';

interface ProviderKeyRow {
  provider: unknown;
  ciphertext: string;
  iv: string;
  wrapped_dek: string;
  dek_iv: string;
  key_version: number;
  last4: string;
  created_at: string;
  validated_at: string | null;
}

interface AuditEventRow {
  provider: unknown;
  action: unknown;
  at: string;
}

function toProviderKeyRecord(row: ProviderKeyRow): ProviderKeyRecord | null {
  if (!isProviderName(row.provider)) {
    return null;
  }
  return {
    provider: row.provider,
    ciphertext: row.ciphertext,
    initializationVector: row.iv,
    wrappedDataEncryptionKey: row.wrapped_dek,
    dataEncryptionKeyInitializationVector: row.dek_iv,
    keyVersion: Number(row.key_version),
    last4: row.last4,
    createdAt: row.created_at,
    validatedAt: row.validated_at ?? null,
  };
}

export function clampAuditEventLimit(limit: number): number {
  return Math.min(AUDIT_EVENT_LIMIT_MAXIMUM, Math.max(AUDIT_EVENT_LIMIT_MINIMUM, Math.floor(limit)));
}

/**
 * The only place that talks to D1. Every statement carries the bound userID,
 * columns are always listed, and the audit table is only inserted into and read.
 */
export function createUserVaultStorage(database: D1Database, userID: string): UserVaultStorage {
  return {
    userID,

    async readProviderKey(provider) {
      const row = await database
        .prepare(SELECT_PROVIDER_KEY_STATEMENT)
        .bind(userID, provider)
        .first<ProviderKeyRow>();
      return row === null ? null : toProviderKeyRecord(row);
    },

    async listProviderKeys() {
      const result = await database.prepare(SELECT_PROVIDER_KEYS_STATEMENT).bind(userID).all<ProviderKeyRow>();
      return result.results
        .map(toProviderKeyRecord)
        .filter((record): record is ProviderKeyRecord => record !== null);
    },

    async writeProviderKey(record) {
      await database
        .prepare(UPSERT_PROVIDER_KEY_STATEMENT)
        .bind(
          userID,
          record.provider,
          record.ciphertext,
          record.initializationVector,
          record.wrappedDataEncryptionKey,
          record.dataEncryptionKeyInitializationVector,
          record.keyVersion,
          record.last4,
          record.createdAt,
          record.validatedAt,
        )
        .run();
    },

    async deleteProviderKey(provider) {
      const result = await database.prepare(DELETE_PROVIDER_KEY_STATEMENT).bind(userID, provider).run();
      return (result.meta.changes ?? 0) > 0;
    },

    async replaceWrappedDataEncryptionKey(provider, previousWrappedDataEncryptionKey, replacement) {
      const result = await database
        .prepare(REPLACE_WRAPPED_DATA_ENCRYPTION_KEY_STATEMENT)
        .bind(
          replacement.wrappedDataEncryptionKey,
          replacement.dataEncryptionKeyInitializationVector,
          userID,
          provider,
          previousWrappedDataEncryptionKey,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async appendAuditEvent(event) {
      await database
        .prepare(INSERT_AUDIT_EVENT_STATEMENT)
        .bind(userID, event.provider, event.action, event.at, event.ipHash, event.userAgentHash)
        .run();
    },

    async listAuditEvents(limit) {
      const result = await database
        .prepare(SELECT_AUDIT_EVENTS_STATEMENT)
        .bind(userID, clampAuditEventLimit(limit))
        .all<AuditEventRow>();
      const events: AuditEventRecord[] = [];
      for (const row of result.results) {
        if (isProviderName(row.provider) && isAuditAction(row.action)) {
          events.push({ provider: row.provider, action: row.action, at: row.at });
        }
      }
      return events;
    },
  };
}
