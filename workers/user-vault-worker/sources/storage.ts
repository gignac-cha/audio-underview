import { createSupabaseClient, type ProviderKeyRow } from '@audio-underview/supabase-connector';
import { isAuditAction, type AuditAction } from './audit.ts';
import type { WrappedDataEncryptionKey } from './envelope.ts';
import type { Environment } from './environment.ts';
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

/**
 * An environment variable of a user. The value is sealed like a provider key, with
 * 'environment-variable:<name>' as the provider and updatedAt as the creation time of the envelope.
 */
export interface EnvironmentVariableRecord {
  name: string;
  ciphertext: string;
  initializationVector: string;
  wrappedDataEncryptionKey: string;
  dataEncryptionKeyInitializationVector: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariableSummary {
  name: string;
  createdAt: string;
  updatedAt: string;
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
  /** Names and times only, by name */
  listEnvironmentVariableSummaries(): Promise<EnvironmentVariableSummary[]>;
  listEnvironmentVariables(): Promise<EnvironmentVariableRecord[]>;
  /**
   * Replaces the envelope of an existing variable and keeps its creation time.
   *
   * @returns the creation time of the variable, or null when the user has no variable of that name
   */
  updateEnvironmentVariable(record: EnvironmentVariableRecord): Promise<string | null>;
  /**
   * Inserts a new variable only while the user has fewer than maximumCount variables,
   * in one transaction. A variable of the same name inserted concurrently is left alone.
   *
   * @returns whether the row was inserted
   */
  insertEnvironmentVariable(record: EnvironmentVariableRecord, maximumCount: number): Promise<boolean>;
  deleteEnvironmentVariable(name: string): Promise<boolean>;
  replaceEnvironmentVariableWrappedDataEncryptionKey(
    name: string,
    previousWrappedDataEncryptionKey: string,
    replacement: WrappedDataEncryptionKey,
  ): Promise<boolean>;
}

export const AUDIT_EVENT_LIMIT_MINIMUM = 1;
export const AUDIT_EVENT_LIMIT_MAXIMUM = 200;

/** What the storage needs of the environment: the Supabase project and the schema of the environment */
export type StorageEnvironment = Pick<Environment, 'SUPABASE_URL' | 'SUPABASE_SCHEMA' | 'SUPABASE_SECRET_KEY'>;

const PROVIDER_KEY_COLUMNS = 'provider, ciphertext, iv, wrapped_dek, dek_iv, key_version, last4, created_at, validated_at';

const ENVIRONMENT_VARIABLE_COLUMNS = 'name, ciphertext, iv, wrapped_dek, dek_iv, key_version, created_at, updated_at';

type SelectedProviderKeyRow = Pick<
  ProviderKeyRow,
  'provider' | 'ciphertext' | 'iv' | 'wrapped_dek' | 'dek_iv' | 'key_version' | 'last4' | 'created_at' | 'validated_at'
>;

function toProviderKeyRecord(row: SelectedProviderKeyRow): ProviderKeyRecord | null {
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

/**
 * supabase-js answers a failed request with an error instead of throwing. A failed call throws
 * here, so a route fails on it as on any other error, and the audit paths that swallow errors swallow it.
 */
function requireSuccess<Data>(
  result: { data: Data; error: null } | { data: null; error: { message: string } },
  operation: string,
): Data {
  if (result.error !== null) {
    throw new Error(`Failed to ${operation}: ${result.error.message}`);
  }
  return result.data;
}

export function clampAuditEventLimit(limit: number): number {
  return Math.min(AUDIT_EVENT_LIMIT_MAXIMUM, Math.max(AUDIT_EVENT_LIMIT_MINIMUM, Math.floor(limit)));
}

/**
 * The only place that talks to Supabase, in the schema of the environment. Every request is
 * filtered by the bound userID or writes it, columns are always listed, and the audit table
 * is only inserted into and read.
 */
export function createUserVaultStorage(environment: StorageEnvironment, userID: string): UserVaultStorage {
  const client = createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
    schema: environment.SUPABASE_SCHEMA,
  });

  return {
    userID,

    async readProviderKey(provider) {
      const row = requireSuccess(
        await client
          .from('provider_keys')
          .select(PROVIDER_KEY_COLUMNS)
          .eq('user_id', userID)
          .eq('provider', provider)
          .maybeSingle(),
        'read provider key',
      );
      return row === null ? null : toProviderKeyRecord(row);
    },

    async listProviderKeys() {
      const rows = requireSuccess(
        await client.from('provider_keys').select(PROVIDER_KEY_COLUMNS).eq('user_id', userID),
        'list provider keys',
      );
      return rows.map(toProviderKeyRecord).filter((record): record is ProviderKeyRecord => record !== null);
    },

    async writeProviderKey(record) {
      // A conflict replaces every envelope column, so a replaced key gets a whole new envelope
      requireSuccess(
        await client.from('provider_keys').upsert(
          {
            user_id: userID,
            provider: record.provider,
            ciphertext: record.ciphertext,
            iv: record.initializationVector,
            wrapped_dek: record.wrappedDataEncryptionKey,
            dek_iv: record.dataEncryptionKeyInitializationVector,
            key_version: record.keyVersion,
            last4: record.last4,
            created_at: record.createdAt,
            validated_at: record.validatedAt,
          },
          { onConflict: 'user_id,provider' },
        ),
        'write provider key',
      );
    },

    async deleteProviderKey(provider) {
      const rows = requireSuccess(
        await client.from('provider_keys').delete().eq('user_id', userID).eq('provider', provider).select('provider'),
        'delete provider key',
      );
      return rows.length > 0;
    },

    async replaceWrappedDataEncryptionKey(provider, previousWrappedDataEncryptionKey, replacement) {
      // The wrapped_dek condition keeps a rewrap from overwriting a row that a
      // concurrent put has already replaced with a new envelope.
      const rows = requireSuccess(
        await client
          .from('provider_keys')
          .update({
            wrapped_dek: replacement.wrappedDataEncryptionKey,
            dek_iv: replacement.dataEncryptionKeyInitializationVector,
          })
          .eq('user_id', userID)
          .eq('provider', provider)
          .eq('wrapped_dek', previousWrappedDataEncryptionKey)
          .select('provider'),
        'replace wrapped data encryption key',
      );
      return rows.length > 0;
    },

    async appendAuditEvent(event) {
      requireSuccess(
        await client.from('key_audit_log').insert({
          user_id: userID,
          provider: event.provider,
          action: event.action,
          at: event.at,
          ip_hash: event.ipHash,
          ua_hash: event.userAgentHash,
        }),
        'append audit event',
      );
    },

    async listEnvironmentVariableSummaries() {
      const rows = requireSuccess(
        await client
          .from('environment_variables')
          .select('name, created_at, updated_at')
          .eq('user_id', userID)
          .order('name', { ascending: true }),
        'list environment variable summaries',
      );
      return rows.map((row) => ({ name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }));
    },

    async listEnvironmentVariables() {
      const rows = requireSuccess(
        await client.from('environment_variables').select(ENVIRONMENT_VARIABLE_COLUMNS).eq('user_id', userID),
        'list environment variables',
      );
      return rows.map((row) => ({
        name: row.name,
        ciphertext: row.ciphertext,
        initializationVector: row.iv,
        wrappedDataEncryptionKey: row.wrapped_dek,
        dataEncryptionKeyInitializationVector: row.dek_iv,
        keyVersion: Number(row.key_version),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    async updateEnvironmentVariable(record) {
      const rows = requireSuccess(
        await client
          .from('environment_variables')
          .update({
            ciphertext: record.ciphertext,
            iv: record.initializationVector,
            wrapped_dek: record.wrappedDataEncryptionKey,
            dek_iv: record.dataEncryptionKeyInitializationVector,
            key_version: record.keyVersion,
            updated_at: record.updatedAt,
          })
          .eq('user_id', userID)
          .eq('name', record.name)
          .select('created_at'),
        'update environment variable',
      );
      return rows[0]?.created_at ?? null;
    },

    async insertEnvironmentVariable(record, maximumCount) {
      // The function of migration 015 keeps the count and the insert in one transaction. A name inserted
      // concurrently is left alone, and the caller then replaces it instead.
      const inserted = requireSuccess(
        await client.rpc('insert_environment_variable', {
          variable: {
            user_id: userID,
            name: record.name,
            ciphertext: record.ciphertext,
            iv: record.initializationVector,
            wrapped_dek: record.wrappedDataEncryptionKey,
            dek_iv: record.dataEncryptionKeyInitializationVector,
            key_version: record.keyVersion,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
          },
          maximum_count: maximumCount,
        }),
        'insert environment variable',
      );
      return inserted === true;
    },

    async deleteEnvironmentVariable(name) {
      const rows = requireSuccess(
        await client.from('environment_variables').delete().eq('user_id', userID).eq('name', name).select('name'),
        'delete environment variable',
      );
      return rows.length > 0;
    },

    async replaceEnvironmentVariableWrappedDataEncryptionKey(name, previousWrappedDataEncryptionKey, replacement) {
      const rows = requireSuccess(
        await client
          .from('environment_variables')
          .update({
            wrapped_dek: replacement.wrappedDataEncryptionKey,
            dek_iv: replacement.dataEncryptionKeyInitializationVector,
          })
          .eq('user_id', userID)
          .eq('name', name)
          .eq('wrapped_dek', previousWrappedDataEncryptionKey)
          .select('name'),
        'replace environment variable wrapped data encryption key',
      );
      return rows.length > 0;
    },

    async listAuditEvents(limit) {
      const rows = requireSuccess(
        await client
          .from('key_audit_log')
          .select('provider, action, at')
          .eq('user_id', userID)
          .order('id', { ascending: false })
          .limit(clampAuditEventLimit(limit)),
        'list audit events',
      );
      const events: AuditEventRecord[] = [];
      for (const row of rows) {
        if (isProviderName(row.provider) && isAuditAction(row.action)) {
          events.push({ provider: row.provider, action: row.action, at: row.at });
        }
      }
      return events;
    },
  };
}
