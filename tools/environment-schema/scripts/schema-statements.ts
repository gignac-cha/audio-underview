import { assertEnvironmentSchema } from './environments.ts';
import { collectCreatedTables } from './created-tables.ts';
import { orderByForeignKeys, type ForeignKey } from './foreign-key-order.ts';
import { partitionMigrations, type MigrationFile } from './migration-files.ts';
import { migrationStatements } from './schema-qualifier.ts';
import { quoteLiteral } from './sql-text.ts';

/** Production's tables and the foreign keys between them, read from `pg_class` and `pg_constraint`. */
export interface ProductionMetadata {
  tables: string[];
  foreignKeys: ForeignKey[];
}

/**
 * Tables whose rows staging does not take from production. The R2 deletion
 * queue names objects of the production bucket, which staging's bucket does
 * not have.
 */
export const UNCOPIED_TABLES: ReadonlySet<string> = new Set(['crawler_file_deletions']);

/** Where development records the migrations it has applied. */
export const DEVELOPMENT_RECORDS_TABLE = 'development.schema_migrations';

export interface StagingPlan {
  sql: string;
  /** Files production has applied, applied before the copy. */
  beforeCopy: string[];
  /** Production's tables that those files create, copied in foreign key order. */
  copiedTables: string[];
  /** Production's tables that none of those files creates (made by hand), so staging has no table to copy them into. */
  skippedTables: string[];
  uncopiedTables: string[];
  /** Files production does not have yet, applied after the copy. */
  afterCopy: string[];
  /** Migrations production has that this checkout has no file for. */
  appliedWithoutFile: string[];
}

export interface DevelopmentPlan {
  /** Undefined when there is nothing to apply. */
  sql: string | undefined;
  /** Whether the schema is dropped and rebuilt from the first file. */
  rebuilt: boolean;
  applied: string[];
}

/**
 * Access for the workers' role: the schema itself, and every table, sequence
 * and function created in it from here on.
 */
function grantStatements(schema: string): string {
  return [
    `GRANT USAGE ON SCHEMA ${schema} TO service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON SEQUENCES TO service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO service_role;`,
  ].join('\n');
}

function textArray(values: string[]): string {
  return `ARRAY[${values.map(quoteLiteral).join(', ')}]::TEXT[]`;
}

/** A block that fails the run when a table of `tables` is not in `schema`. */
function requireTablesStatement(schema: string, tables: string[], message: string): string {
  return `DO $require$
DECLARE
  missing_tables TEXT;
BEGIN
  SELECT string_agg(expected_table, ', ' ORDER BY expected_table)
  INTO missing_tables
  FROM unnest(${textArray(tables)}) AS expected_table
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE relnamespace = '${schema}'::regnamespace
      AND relname = expected_table
      AND relkind IN ('r', 'p')
  );
  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION '${message}: %', missing_tables;
  END IF;
END
$require$;
`;
}

/**
 * Production's rows into the staging tables of the same name, `tables` in
 * order. Every table the files production has create must be in staging by
 * now, or the run fails rather than leave a table without production's rows.
 * The migrations seed rows of their own (the system user and its crawlers),
 * so staging is emptied first and holds exactly production's rows. Only the
 * columns both tables have are copied; a column whose type differs (an enum
 * is a separate type in each schema) goes through its text form.
 */
function copyStatements(tables: string[], createdTables: string[]): string {
  return `-- Copy production's rows
SET LOCAL search_path TO '';

${requireTablesStatement('staging', createdTables, 'tables the migrations production has create are missing from staging before the copy')}
DO $truncate$
DECLARE
  table_list TEXT;
BEGIN
  SELECT string_agg(format('staging.%I', relname), ', ')
  INTO table_list
  FROM pg_catalog.pg_class
  WHERE relnamespace = 'staging'::regnamespace
    AND relkind IN ('r', 'p');
  IF table_list IS NOT NULL THEN
    EXECUTE 'TRUNCATE ' || table_list;
  END IF;
END
$truncate$;

CREATE TEMPORARY TABLE environment_schema_copies (
  copy_order INTEGER NOT NULL,
  table_name TEXT NOT NULL,
  row_count BIGINT NOT NULL
) ON COMMIT DROP;

DO $copy$
DECLARE
  copied_tables TEXT[] := ${textArray(tables)};
  table_index INTEGER;
  column_list TEXT;
  value_list TEXT;
  copied_rows BIGINT;
BEGIN
  FOR table_index IN 1 .. coalesce(array_length(copied_tables, 1), 0) LOOP
    SELECT
      string_agg(quote_ident(target_column.attname), ', ' ORDER BY target_column.attnum),
      string_agg(
        CASE
          WHEN target_column.atttypid = source_column.atttypid THEN quote_ident(source_column.attname)
          ELSE format('%I::text::%s', source_column.attname, format_type(target_column.atttypid, target_column.atttypmod))
        END,
        ', ' ORDER BY target_column.attnum
      )
    INTO column_list, value_list
    FROM pg_catalog.pg_attribute AS target_column
    JOIN pg_catalog.pg_attribute AS source_column ON source_column.attname = target_column.attname
    WHERE target_column.attrelid = to_regclass(format('staging.%I', copied_tables[table_index]))
      AND source_column.attrelid = to_regclass(format('public.%I', copied_tables[table_index]))
      AND target_column.attnum > 0
      AND NOT target_column.attisdropped
      AND target_column.attgenerated = ''
      AND source_column.attnum > 0
      AND NOT source_column.attisdropped;

    IF column_list IS NULL THEN
      RAISE EXCEPTION 'staging.% shares no column with public.%, so its rows cannot be copied', copied_tables[table_index], copied_tables[table_index];
    END IF;

    EXECUTE format(
      'INSERT INTO staging.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM public.%I',
      copied_tables[table_index], column_list, value_list, copied_tables[table_index]
    );
    GET DIAGNOSTICS copied_rows = ROW_COUNT;
    INSERT INTO pg_temp.environment_schema_copies (copy_order, table_name, row_count)
    VALUES (table_index, copied_tables[table_index], copied_rows);
  END LOOP;
END
$copy$;
`;
}

/**
 * Fails the run, so nothing of it is kept, when a function of the schema
 * still reaches `public` or a table the files create is not in the schema
 * (an unqualified name would then find production's table through
 * PostgREST's extra search path). The function check is strict and plain: it
 * reads the whole body, so a comment that writes `public.` fails it too, and
 * it cannot see a schema name that dynamic SQL puts together at run time.
 */
function checkStatements(schema: string, expectedTables: string[]): string {
  return `-- Check that ${schema} does not reach production
DO $check$
DECLARE
  offending_functions TEXT;
BEGIN
  SELECT string_agg(format('%s(%s)', proname, pg_catalog.pg_get_function_identity_arguments(oid)), ', ' ORDER BY proname)
  INTO offending_functions
  FROM pg_catalog.pg_proc
  WHERE pronamespace = '${schema}'::regnamespace
    AND (
      prosrc ~* '(^|[^[:alnum:]_$])"?public"?\\s*\\.'
      OR EXISTS (
        SELECT 1 FROM unnest(proconfig) AS setting
        WHERE setting ~* '^search_path=(.*[^[:alnum:]_$])?"?public"?([^[:alnum:]_$]|$)'
      )
    );
  IF offending_functions IS NOT NULL THEN
    RAISE EXCEPTION 'functions in ${schema} still refer to public: %. The check reads the whole function body, comments included, so a comment that writes public. fails it too. It does not inspect dynamic SQL: a schema name put together at run time is not seen.', offending_functions;
  END IF;
END
$check$;

${requireTablesStatement(schema, expectedTables, `tables the migrations create are missing from ${schema}`)}`;
}

function transaction(statements: string[]): string {
  return ['BEGIN;', '', ...statements.map((statement) => statement.trimEnd()).flatMap((statement) => [statement, '']), 'COMMIT;', ''].join('\n');
}

/** `names` for a message or the log. */
export function list(names: string[]): string {
  return names.length === 0 ? 'none' : names.join(', ');
}

/**
 * Throws when production's migration history does not line up with the
 * files, since staging would then be rebuilt without production's rows: no
 * name production lists has a file here (names recorded under another rule),
 * production has tables but lists no migration a file here has (an empty
 * answer), production lists migrations but no table was read (an empty
 * metadata answer), none of the tables it would copy is made by the files it
 * has, or production already has a table that only a file it does not list
 * makes (a list cut short).
 */
function assertProductionMatchesFiles({
  productionMigrationNames,
  production,
  applied,
  copyableTables,
  copiedTables,
  skippedTables,
  createdByPending,
}: {
  productionMigrationNames: string[];
  production: ProductionMetadata;
  applied: MigrationFile[];
  copyableTables: string[];
  copiedTables: string[];
  skippedTables: string[];
  createdByPending: Set<string>;
}): void {
  const refusal = "Refusing to rebuild staging, which would get none of production's rows.";
  if (productionMigrationNames.length > 0 && applied.length === 0) {
    throw new Error(
      `none of the ${productionMigrationNames.length} migrations production lists has a file here (production: ${list(productionMigrationNames)}). A file counts as applied when its name without the number prefix and .sql matches. ${refusal}`,
    );
  }
  if (production.tables.length > 0 && applied.length === 0) {
    throw new Error(
      `production has tables in public (${list(production.tables)}) but lists no applied migration, so which files it has is unknown. ${refusal}`,
    );
  }
  if (applied.length > 0 && production.tables.length === 0) {
    throw new Error(
      `production lists ${applied.length} applied migrations but no table in public was read, so the metadata answer is incomplete. ${refusal}`,
    );
  }
  if (copyableTables.length > 0 && copiedTables.length === 0) {
    throw new Error(
      `none of production's tables (${list(copyableTables)}) is created by the migrations production has (${list(applied.map((file) => file.fileName))}). ${refusal}`,
    );
  }
  const madeByUnlistedFiles = skippedTables.filter((table) => createdByPending.has(table));
  if (madeByUnlistedFiles.length > 0) {
    throw new Error(
      `production already has tables (${list(madeByUnlistedFiles)}) that only migrations it does not list create, so its migration list is incomplete. Refusing to rebuild staging, which would miss those rows.`,
    );
  }
}

/**
 * The SQL that rebuilds staging from production in one transaction: the
 * migrations production has, production's rows, then the migrations this
 * checkout adds. It only reads `public`. Throws, before any SQL is sent, when
 * production's history does not match the files.
 */
export function planStaging(files: MigrationFile[], productionMigrationNames: string[], production: ProductionMetadata): StagingPlan {
  const schema = 'staging';
  const { applied, pending, appliedWithoutFile } = partitionMigrations(files, productionMigrationNames);
  const createdBeforeCopy = collectCreatedTables(applied);
  const created = new Set(createdBeforeCopy);
  const copyableTables = production.tables.filter((table) => !UNCOPIED_TABLES.has(table));
  const copiedTables = orderByForeignKeys(
    copyableTables.filter((table) => created.has(table)),
    production.foreignKeys,
  );
  const skippedTables = copyableTables.filter((table) => !created.has(table));
  assertProductionMatchesFiles({
    productionMigrationNames,
    production,
    applied,
    copyableTables,
    copiedTables,
    skippedTables,
    createdByPending: new Set(collectCreatedTables(pending)),
  });

  const sql = transaction([
    `DROP SCHEMA IF EXISTS ${schema} CASCADE;\nCREATE SCHEMA ${schema};`,
    grantStatements(schema),
    ...applied.map((file) => migrationStatements(file, schema)),
    copyStatements(copiedTables, createdBeforeCopy),
    ...pending.map((file) => migrationStatements(file, schema)),
    `NOTIFY pgrst, 'reload schema';`,
    checkStatements(schema, collectCreatedTables(files)),
    'SELECT table_name, row_count FROM pg_temp.environment_schema_copies ORDER BY copy_order;',
  ]);

  return {
    sql,
    beforeCopy: applied.map((file) => file.fileName),
    copiedTables,
    skippedTables,
    uncopiedTables: production.tables.filter((table) => UNCOPIED_TABLES.has(table)),
    afterCopy: pending.map((file) => file.fileName),
    appliedWithoutFile,
  };
}

/**
 * The SQL that brings development up to the files in one transaction. It
 * keeps the data and applies the files not recorded yet, or, when `reset` or
 * when the schema does not exist (`recordedNames` undefined), drops the
 * schema and applies every file. Throws when a recorded migration has no file
 * any more, since the schema no longer matches the files.
 */
export function planDevelopment(files: MigrationFile[], recordedNames: string[] | undefined, reset: boolean): DevelopmentPlan {
  const schema = 'development';
  assertEnvironmentSchema(schema);
  const rebuilt = reset || recordedNames === undefined;

  if (!rebuilt) {
    const fileNames = new Set(files.map((file) => file.name));
    const missing = recordedNames.filter((name) => !fileNames.has(name));
    if (missing.length > 0) {
      throw new Error(
        `${DEVELOPMENT_RECORDS_TABLE} records migrations that have no file: ${missing.join(', ')}. Run again with --reset to rebuild development from the files (its data is removed).`,
      );
    }
  }

  const recorded = new Set(rebuilt ? [] : recordedNames);
  const toApply = files.filter((file) => !recorded.has(file.name));
  if (toApply.length === 0) {
    return { sql: undefined, rebuilt, applied: [] };
  }

  const sql = transaction([
    ...(rebuilt
      ? [
          `DROP SCHEMA IF EXISTS ${schema} CASCADE;\nCREATE SCHEMA ${schema};`,
          grantStatements(schema),
          `CREATE TABLE ${DEVELOPMENT_RECORDS_TABLE} (\n  name TEXT PRIMARY KEY,\n  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);`,
        ]
      : [grantStatements(schema)]),
    ...toApply.map(
      (file) => `${migrationStatements(file, schema)}INSERT INTO ${DEVELOPMENT_RECORDS_TABLE} (name) VALUES (${quoteLiteral(file.name)});\n`,
    ),
    `NOTIFY pgrst, 'reload schema';`,
    checkStatements(schema, collectCreatedTables(files)),
  ]);

  return { sql, rebuilt, applied: toApply.map((file) => file.fileName) };
}
