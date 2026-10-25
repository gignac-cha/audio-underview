import { assertEnvironmentSchema } from './environments.ts';
import { collectCreatedTables } from './created-tables.ts';
import { orderByForeignKeys, type ForeignKey } from './foreign-key-order.ts';
import { partitionMigrations, type MigrationFile } from './migration-files.ts';
import { migrationStatements } from './schema-qualifier.ts';
import { quoteLiteral } from './sql-text.ts';
import { assertTableGrants, LAST_MIGRATION_WITH_AUTOMATIC_GRANTS, reliesOnAutomaticGrants } from './table-grants.ts';

/** Production's tables and the foreign keys between them, read from `pg_class` and `pg_constraint`. */
export interface ProductionMetadata {
  tables: string[];
  foreignKeys: ForeignKey[];
}

/**
 * Tables whose rows staging does not take from production. The R2 deletion
 * queue names objects of the production bucket, which staging's bucket does
 * not have. The user vault's rows are encrypted with the key encryption key
 * (KEK) of the environment that wrote them, and staging has its own, so
 * production's provider keys and environment variables could not be read
 * there; their audit log describes those keys and stays behind with them. The
 * newscasts' audio is in the production R2 bucket, which staging's newscast
 * worker does not read, so a copied newscast could not play there; its share
 * links go with it. The tables are still made and get production's privileges
 * like any other.
 */
export const UNCOPIED_TABLES: ReadonlySet<string> = new Set([
  'crawler_file_deletions',
  'provider_keys',
  'key_audit_log',
  'environment_variables',
  'newscasts',
  'newscast_shares',
]);

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

/** The roles the Data API uses, whose privileges staging takes from production. */
const DATA_API_ROLES = ['anon', 'authenticated', 'service_role'];

/**
 * Access for the workers' role to the schema itself. Nothing in it gets
 * default privileges: production's new tables and sequences get none from
 * Supabase from 2026-10-30, so a migration that forgets its GRANT has to fail
 * here as it would there. Functions get none either, which leaves them
 * PostgreSQL's EXECUTE for PUBLIC; a migration that revokes that grants
 * service_role itself, as 011 and 013 do.
 */
function schemaUsageStatement(schema: string): string {
  return `GRANT USAGE ON SCHEMA ${schema} TO service_role;`;
}

/**
 * Removes the default privileges an earlier version of this tool set, so a
 * schema it built stops granting what is created in it from here on.
 */
function revokeDefaultPrivilegesStatement(schema: string): string {
  return [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM service_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON FUNCTIONS FROM service_role;`,
  ].join('\n');
}

function textArray(values: string[]): string {
  return `ARRAY[${values.map(quoteLiteral).join(', ')}]::TEXT[]`;
}

/** `<schema>.<name>`, quoting the name unless it is a plain lower-case one. */
function qualifiedName(schema: string, name: string): string {
  return `${schema}.${/^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`}`;
}

/**
 * ALL on `tables` for service_role. The migrations up to
 * {@link LAST_MIGRATION_WITH_AUTOMATIC_GRANTS} grant nothing on their tables,
 * which got their privileges from Supabase in production.
 */
function automaticGrantStatement(schema: string, tables: string[]): string {
  const last = String(LAST_MIGRATION_WITH_AUTOMATIC_GRANTS).padStart(3, '0');
  return `-- Tables of the migrations up to ${last}, which Supabase granted in production
GRANT ALL ON TABLE ${tables.map((table) => qualifiedName(schema, table)).join(', ')} TO service_role;
`;
}

/**
 * `statementOf` for each of `files` (in number order). After the last one up
 * to {@link LAST_MIGRATION_WITH_AUTOMATIC_GRANTS}, and before any later one
 * could change them, the tables those files create get ALL for service_role.
 * The later files' tables get only what their own GRANT statements give.
 */
function applyStatements(files: MigrationFile[], schema: string, statementOf: (file: MigrationFile) => string): string[] {
  const statements = files.map(statementOf);
  const automatic = files.filter(reliesOnAutomaticGrants);
  const tables = collectCreatedTables(automatic);
  if (tables.length > 0) {
    statements.splice(files.indexOf(automatic[automatic.length - 1]) + 1, 0, automaticGrantStatement(schema, tables));
  }
  return statements;
}

/**
 * Gives every staging table, view and sequence that public also has exactly
 * the privileges the Data API roles hold on public's, read from the catalog
 * inside the run: production's tables keep what Supabase granted them when
 * they were made, which a table made now would not get. It runs after the
 * migrations production has and before the ones it does not, so those change
 * production's privileges as they would in production and their own tables
 * get only what they grant. Column privileges are not copied.
 */
function productionPrivilegesStatement(): string {
  return `-- Give staging production's privileges
DO $privileges$
DECLARE
  data_api_roles TEXT;
  shared_relation RECORD;
  production_privilege RECORD;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname)
  INTO data_api_roles
  FROM pg_catalog.pg_roles
  WHERE rolname = ANY (${textArray(DATA_API_ROLES)});

  FOR shared_relation IN
    SELECT
      staging_relation.relname,
      CASE WHEN staging_relation.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS object_type,
      public_relation.relacl
    FROM pg_catalog.pg_class AS staging_relation
    JOIN pg_catalog.pg_class AS public_relation
      ON public_relation.relname = staging_relation.relname
      AND public_relation.relnamespace = 'public'::regnamespace
      AND (public_relation.relkind = 'S') = (staging_relation.relkind = 'S')
    WHERE staging_relation.relnamespace = 'staging'::regnamespace
      AND staging_relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND public_relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY staging_relation.relname
  LOOP
    EXECUTE format('REVOKE ALL ON %s staging.%I FROM %s', shared_relation.object_type, shared_relation.relname, data_api_roles);
    FOR production_privilege IN
      SELECT granted.privilege_type, grantee_role.rolname, granted.is_grantable
      FROM pg_catalog.aclexplode(shared_relation.relacl) AS granted
      JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid = granted.grantee
      WHERE grantee_role.rolname = ANY (${textArray(DATA_API_ROLES)})
      ORDER BY grantee_role.rolname, granted.privilege_type
    LOOP
      EXECUTE format(
        'GRANT %s ON %s staging.%I TO %I%s',
        production_privilege.privilege_type,
        shared_relation.object_type,
        shared_relation.relname,
        production_privilege.rolname,
        CASE WHEN production_privilege.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
      );
    END LOOP;
  END LOOP;
END
$privileges$;
`;
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
 * migrations production has, production's rows and privileges, then the
 * migrations this checkout adds. It only reads `public`. Throws, before any
 * SQL is sent, when production's history does not match the files or a file
 * does not grant the tables it creates.
 */
export function planStaging(files: MigrationFile[], productionMigrationNames: string[], production: ProductionMetadata): StagingPlan {
  const schema = 'staging';
  assertTableGrants(files);
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
    schemaUsageStatement(schema),
    ...applied.map((file) => migrationStatements(file, schema)),
    copyStatements(copiedTables, createdBeforeCopy),
    productionPrivilegesStatement(),
    ...applyStatements(pending, schema, (file) => migrationStatements(file, schema)),
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
 * schema and applies every file. There is no production to take privileges
 * from: the tables of the files up to {@link LAST_MIGRATION_WITH_AUTOMATIC_GRANTS}
 * get ALL for service_role, later ones what they grant. Throws when a
 * recorded migration has no file any more, since the schema no longer
 * matches the files, or when a file does not grant the tables it creates.
 */
export function planDevelopment(files: MigrationFile[], recordedNames: string[] | undefined, reset: boolean): DevelopmentPlan {
  const schema = 'development';
  assertEnvironmentSchema(schema);
  assertTableGrants(files);
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
          schemaUsageStatement(schema),
          `CREATE TABLE ${DEVELOPMENT_RECORDS_TABLE} (\n  name TEXT PRIMARY KEY,\n  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);`,
        ]
      : [schemaUsageStatement(schema), revokeDefaultPrivilegesStatement(schema)]),
    ...applyStatements(
      toApply,
      schema,
      (file) => `${migrationStatements(file, schema)}INSERT INTO ${DEVELOPMENT_RECORDS_TABLE} (name) VALUES (${quoteLiteral(file.name)});\n`,
    ),
    `NOTIFY pgrst, 'reload schema';`,
    checkStatements(schema, collectCreatedTables(files)),
  ]);

  return { sql, rebuilt, applied: toApply.map((file) => file.fileName) };
}
