import type { Environment } from './environments.ts';
import type { ForeignKey } from './foreign-key-order.ts';
import type { MigrationFile } from './migration-files.ts';
import { DEVELOPMENT_RECORDS_TABLE, list, planDevelopment, planStaging, type DevelopmentPlan, type ProductionMetadata, type StagingPlan } from './schema-statements.ts';

export type Row = Record<string, unknown>;

/**
 * The database the schemas are built in. The Supabase Management API is one;
 * tests and local checks can put any PostgreSQL behind it.
 */
export interface SchemaDatabase {
  /** Names of the migrations production has applied. */
  listProductionMigrationNames(): Promise<string[]>;
  /** Runs `sql` and returns the rows of its last statement that returned rows. */
  query(sql: string, options?: { readOnly?: boolean }): Promise<Row[]>;
}

/** Production's tables and the foreign keys between them. */
export const PRODUCTION_METADATA_QUERY = `SELECT
  (
    SELECT coalesce(json_agg(relname ORDER BY relname), '[]'::json)
    FROM pg_catalog.pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relkind IN ('r', 'p')
      AND NOT relispartition
  ) AS tables,
  (
    SELECT coalesce(
      json_agg(json_build_object('table', referencing.relname, 'references', referenced.relname) ORDER BY referencing.relname, referenced.relname),
      '[]'::json
    )
    FROM pg_catalog.pg_constraint
    JOIN pg_catalog.pg_class AS referencing ON referencing.oid = pg_constraint.conrelid
    JOIN pg_catalog.pg_class AS referenced ON referenced.oid = pg_constraint.confrelid
    WHERE pg_constraint.contype = 'f'
      AND referencing.relnamespace = 'public'::regnamespace
      AND referenced.relnamespace = 'public'::regnamespace
  ) AS foreign_keys`;

export const DEVELOPMENT_STATE_QUERY = `SELECT
  to_regnamespace('development') IS NOT NULL AS schema_exists,
  to_regclass('${DEVELOPMENT_RECORDS_TABLE}') IS NOT NULL AS records_exist`;

export const DEVELOPMENT_RECORDS_QUERY = `SELECT name FROM ${DEVELOPMENT_RECORDS_TABLE} ORDER BY name`;

export type BuildSummary =
  | { environment: 'staging'; plan: StagingPlan; copiedRows: { table: string; rows: number }[] | undefined }
  | { environment: 'development'; plan: DevelopmentPlan; firstRun: boolean };

/** JSON columns may come back parsed or as text, depending on the client. */
function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function isForeignKey(value: unknown): value is ForeignKey {
  return typeof value === 'object' && value !== null && typeof (value as ForeignKey).table === 'string' && typeof (value as ForeignKey).references === 'string';
}

export function parseProductionMetadata(rows: Row[]): ProductionMetadata {
  const tables = jsonValue(rows[0]?.tables);
  const foreignKeys = jsonValue(rows[0]?.foreign_keys);
  if (!Array.isArray(tables) || !tables.every((table) => typeof table === 'string') || !Array.isArray(foreignKeys) || !foreignKeys.every(isForeignKey)) {
    throw new Error(`unexpected answer to the production metadata query: ${JSON.stringify(rows).slice(0, 200)}`);
  }
  return { tables, foreignKeys };
}

/** A row count as a client returns it: a number, or its text. */
function rowCount(value: unknown): number | undefined {
  const count = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
  return count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/**
 * Row counts of the staging copy: one row for each of `copiedTables`, in
 * order. Undefined when the answer is anything else, as when the client did
 * not return the rows of the last statement. With no table to copy, nothing
 * was copied whatever came back (a client may return an earlier statement's
 * rows when the last one has none).
 */
function parseCopiedRows(rows: Row[], copiedTables: string[]): { table: string; rows: number }[] | undefined {
  if (copiedTables.length === 0) {
    return [];
  }
  const copiedRows = rows.map((row) => ({ table: row.table_name, rows: rowCount(row.row_count) }));
  const complete =
    copiedRows.length === copiedTables.length && copiedRows.every((row, index) => row.table === copiedTables[index] && row.rows !== undefined);
  return complete ? copiedRows.map((row) => ({ table: row.table as string, rows: row.rows as number })) : undefined;
}

/** Development's recorded migration names, or undefined when the schema does not exist yet. */
async function readDevelopmentRecords(database: SchemaDatabase): Promise<string[] | undefined> {
  const [state] = await database.query(DEVELOPMENT_STATE_QUERY, { readOnly: true });
  if (state?.schema_exists !== true) {
    return undefined;
  }
  if (state.records_exist !== true) {
    throw new Error(
      `the development schema exists without ${DEVELOPMENT_RECORDS_TABLE}, so which migrations it has is unknown. Run again with --reset to rebuild it (its data is removed).`,
    );
  }
  const rows = await database.query(DEVELOPMENT_RECORDS_QUERY, { readOnly: true });
  return rows.map((row) => String(row.name));
}

/** Builds the schema of `environment` and reports what it applied and copied. */
export async function buildEnvironmentSchema({
  environment,
  reset,
  files,
  database,
}: {
  environment: Environment;
  reset: boolean;
  files: MigrationFile[];
  database: SchemaDatabase;
}): Promise<BuildSummary> {
  if (environment === 'staging') {
    const productionMigrationNames = await database.listProductionMigrationNames();
    const production = parseProductionMetadata(await database.query(PRODUCTION_METADATA_QUERY, { readOnly: true }));
    const plan = planStaging(files, productionMigrationNames, production);
    const copiedRows = parseCopiedRows(await database.query(plan.sql), plan.copiedTables);
    return { environment, plan, copiedRows };
  }

  const recordedNames = reset ? undefined : await readDevelopmentRecords(database);
  const plan = planDevelopment(files, recordedNames, reset);
  if (plan.sql !== undefined) {
    await database.query(plan.sql);
  }
  return { environment, plan, firstRun: !reset && recordedNames === undefined };
}

/** A few lines on what a build did, for the log. */
export function formatSummary(summary: BuildSummary): string[] {
  if (summary.environment === 'staging') {
    const { plan, copiedRows } = summary;
    const copied =
      copiedRows === undefined ? 'unknown, the run did not return its row counts' : list(copiedRows.map(({ table, rows }) => `${table} ${rows}`));
    return [
      'staging: rebuilt from production',
      `  migrations production has (${plan.beforeCopy.length}): ${list(plan.beforeCopy)}`,
      `  rows copied from production: ${copied}`,
      `  skipped, no migration production has creates them: ${list(plan.skippedTables)}`,
      `  not copied: ${list(plan.uncopiedTables)}`,
      `  migrations production does not have yet (${plan.afterCopy.length}): ${list(plan.afterCopy)}`,
      ...(plan.appliedWithoutFile.length > 0 ? [`  warning: production has migrations this checkout has no file for: ${list(plan.appliedWithoutFile)}`] : []),
    ];
  }

  const { plan, firstRun } = summary;
  if (plan.rebuilt) {
    return [`development: rebuilt from the first migration (${firstRun ? 'first run' : '--reset'}), data removed`, `  applied (${plan.applied.length}): ${list(plan.applied)}`];
  }
  if (plan.applied.length === 0) {
    return ['development: up to date, nothing to apply'];
  }
  return [`development: kept its data and applied ${plan.applied.length} new migration${plan.applied.length === 1 ? '' : 's'}: ${list(plan.applied)}`];
}
