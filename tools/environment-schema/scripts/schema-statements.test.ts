import { describe, expect, it } from 'vitest';
import { migrationName, type MigrationFile } from './migration-files.ts';
import { planDevelopment, planStaging } from './schema-statements.ts';

const file = (fileName: string, sql: string): MigrationFile => ({ fileName, name: migrationName(fileName), sql });

const files = [
  file('001_create_users.sql', 'CREATE TABLE users (uuid UUID PRIMARY KEY);\n'),
  file('002_create_crawlers.sql', 'CREATE TABLE crawlers (id UUID PRIMARY KEY, user_uuid UUID REFERENCES users(uuid));\n'),
  file('003_create_deletions.sql', 'CREATE TABLE crawler_file_deletions (object_key TEXT PRIMARY KEY);\n'),
  file(
    '004_add_cleanup.sql',
    "CREATE FUNCTION clean() RETURNS VOID LANGUAGE sql SET search_path = '' AS $$ DELETE FROM public.crawlers $$;\nREVOKE EXECUTE ON FUNCTION clean() FROM PUBLIC;\n",
  ),
];

const production = {
  tables: ['crawler_file_deletions', 'crawlers', 'users'],
  foreignKeys: [{ table: 'crawlers', references: 'users' }],
};

/** Statements that would change something in public. */
const WRITES_TO_PUBLIC =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|ALTER\s+\w+|DROP\s+\w+|CREATE\s+(?:OR\s+REPLACE\s+)?\w+|GRANT\s+[^;]*\bON|COMMENT\s+ON\s+\w+)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?"?public"?\./i;

function indexOf(sql: string, text: string): number {
  const index = sql.indexOf(text);
  expect(index, text).toBeGreaterThanOrEqual(0);
  return index;
}

describe('planStaging', () => {
  const productionNames = ['create_users', 'create_crawlers', 'create_deletions'];
  const plan = planStaging(files, productionNames, production);

  it('rebuilds staging in one transaction', () => {
    expect(plan.sql.startsWith('BEGIN;\n')).toBe(true);
    expect(plan.sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(plan.sql.match(/^(?:BEGIN|COMMIT);$/gm)).toEqual(['BEGIN;', 'COMMIT;']);
  });

  it('drops and creates the schema, then grants, then the migrations production has, the copy and the new migrations', () => {
    const order = [
      'DROP SCHEMA IF EXISTS staging CASCADE;',
      'CREATE SCHEMA staging;',
      'GRANT USAGE ON SCHEMA staging TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA staging GRANT ALL ON TABLES TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA staging GRANT ALL ON SEQUENCES TO service_role;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA staging GRANT EXECUTE ON FUNCTIONS TO service_role;',
      '-- 001_create_users.sql',
      '-- 002_create_crawlers.sql',
      '-- 003_create_deletions.sql',
      "-- Copy production's rows",
      "RAISE EXCEPTION 'tables the migrations production has create are missing from staging before the copy: %'",
      'TRUNCATE',
      "copied_tables TEXT[] := ARRAY['users', 'crawlers']::TEXT[];",
      '-- 004_add_cleanup.sql',
      "NOTIFY pgrst, 'reload schema';",
      '-- Check that staging does not reach production',
      'SELECT table_name, row_count FROM pg_temp.environment_schema_copies ORDER BY copy_order;',
      'COMMIT;',
    ].map((text) => indexOf(plan.sql, text));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('gives each file its search path and rewrites its qualifiers', () => {
    expect(plan.sql).toContain('-- 004_add_cleanup.sql\nSET LOCAL search_path TO staging;\nCREATE FUNCTION clean()');
    expect(plan.sql).toContain('DELETE FROM staging.crawlers');
    expect(plan.sql).toContain('FROM PUBLIC;');
  });

  it('copies in foreign key order without the R2 deletion queue', () => {
    expect(plan.copiedTables).toEqual(['users', 'crawlers']);
    expect(plan.skippedTables).toEqual([]);
    expect(plan.uncopiedTables).toEqual(['crawler_file_deletions']);
    expect(plan.beforeCopy).toEqual(['001_create_users.sql', '002_create_crawlers.sql', '003_create_deletions.sql']);
    expect(plan.afterCopy).toEqual(['004_add_cleanup.sql']);
  });

  it('copies only shared columns and casts the ones whose types differ', () => {
    expect(plan.sql).toContain("'INSERT INTO staging.%I (%s) OVERRIDING SYSTEM VALUE SELECT %s FROM public.%I'");
    expect(plan.sql).toContain("format('%I::text::%s', source_column.attname, format_type(target_column.atttypid, target_column.atttypmod))");
  });

  it('fails the copy instead of skipping a table the migrations production has should have made', () => {
    const copy = plan.sql.slice(indexOf(plan.sql, "-- Copy production's rows"), indexOf(plan.sql, '-- 004_add_cleanup.sql'));
    expect(copy).toContain("unnest(ARRAY['users', 'crawlers', 'crawler_file_deletions']::TEXT[])");
    expect(copy).toContain("RAISE EXCEPTION 'staging.% shares no column with public.%, so its rows cannot be copied'");
    expect(copy).not.toContain('CONTINUE');
  });

  it('skips production tables no migration production has creates, and lists them', () => {
    const handMade = planStaging(files, ['create_users'], { tables: ['manual_notes', 'users'], foreignKeys: [] });
    expect(handMade.copiedTables).toEqual(['users']);
    expect(handMade.skippedTables).toEqual(['manual_notes']);
    expect(handMade.sql).toContain("copied_tables TEXT[] := ARRAY['users']::TEXT[];");
  });

  it('checks function bodies and the tables of every file', () => {
    expect(plan.sql).toContain(
      "RAISE EXCEPTION 'functions in staging still refer to public: %. The check reads the whole function body, comments included, so a comment that writes public. fails it too. It does not inspect dynamic SQL: a schema name put together at run time is not seen.'",
    );
    const check = plan.sql.slice(indexOf(plan.sql, '-- Check that staging does not reach production'));
    expect(check).toContain("unnest(ARRAY['users', 'crawlers', 'crawler_file_deletions']::TEXT[])");
    expect(check).toContain("RAISE EXCEPTION 'tables the migrations create are missing from staging: %'");
  });

  it('only reads public', () => {
    expect(plan.sql).not.toMatch(WRITES_TO_PUBLIC);
    expect(plan.sql).not.toMatch(/\bSCHEMA\s+"?public"?(?![\w$])/i);
  });

  it('applies every file after the copy when production is empty', () => {
    const fresh = planStaging(files, [], { tables: [], foreignKeys: [] });
    expect(fresh.beforeCopy).toEqual([]);
    expect(fresh.copiedTables).toEqual([]);
    expect(fresh.afterCopy).toHaveLength(4);
    expect(indexOf(fresh.sql, "-- Copy production's rows")).toBeLessThan(indexOf(fresh.sql, '-- 001_create_users.sql'));
  });

  it('reports production migrations this checkout has no file for', () => {
    expect(planStaging(files, [...productionNames, 'add_from_newer_main'], production).appliedWithoutFile).toEqual(['add_from_newer_main']);
  });

  it('refuses when production has tables but lists no applied migration', () => {
    expect(() => planStaging(files, [], production)).toThrow(
      /^production has tables in public \(crawler_file_deletions, crawlers, users\) but lists no applied migration.*Refusing to rebuild staging/,
    );
  });

  it('refuses when no name production lists has a file, even on an empty production', () => {
    for (const tables of [production.tables, []]) {
      expect(() => planStaging(files, ['001_create_users', '002_create_crawlers'], { tables, foreignKeys: [] })).toThrow(
        /^none of the 2 migrations production lists has a file here \(production: 001_create_users, 002_create_crawlers\)/,
      );
    }
  });

  it('refuses when the migrations production has create none of its tables', () => {
    expect(() => planStaging(files, ['add_cleanup'], production)).toThrow(
      /^none of production's tables \(crawlers, users\) is created by the migrations production has \(004_add_cleanup.sql\)/,
    );
  });

  it('refuses when production lists migrations but no table was read', () => {
    expect(() => planStaging(files, productionNames, { tables: [], foreignKeys: [] })).toThrow(
      /^production lists 3 applied migrations but no table in public was read.*Refusing to rebuild staging/,
    );
  });

  it('refuses when production has a table that only a migration it does not list creates', () => {
    expect(() => planStaging(files, ['create_users'], production)).toThrow(
      /^production already has tables \(crawlers\) that only migrations it does not list create.*Refusing to rebuild staging/,
    );
  });

  it('fails before building SQL when the foreign keys form a cycle', () => {
    expect(() =>
      planStaging([file('001_create_a_and_b.sql', 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n')], ['create_a_and_b'], {
        tables: ['a', 'b'],
        foreignKeys: [
          { table: 'a', references: 'b' },
          { table: 'b', references: 'a' },
        ],
      }),
    ).toThrow(/cycle/);
  });

  it('fails before building SQL when a file would escape the schema', () => {
    expect(() => planStaging([...files, file('005_grant.sql', 'GRANT USAGE ON SCHEMA public TO anon;')], productionNames, production)).toThrow(
      /005_grant.sql cannot be applied to staging/,
    );
  });
});

describe('planDevelopment', () => {
  it('applies only the files not recorded, records them and keeps the data', () => {
    const plan = planDevelopment(files, ['create_users', 'create_crawlers'], false);
    expect(plan.rebuilt).toBe(false);
    expect(plan.applied).toEqual(['003_create_deletions.sql', '004_add_cleanup.sql']);
    const sql = plan.sql ?? '';
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).not.toContain('DROP SCHEMA');
    expect(sql).not.toContain('CREATE TABLE development.schema_migrations');
    expect(sql).not.toContain('-- 001_create_users.sql');
    expect(indexOf(sql, 'GRANT USAGE ON SCHEMA development TO service_role;')).toBeLessThan(indexOf(sql, '-- 003_create_deletions.sql'));
    expect(indexOf(sql, "INSERT INTO development.schema_migrations (name) VALUES ('create_deletions');")).toBeLessThan(
      indexOf(sql, '-- 004_add_cleanup.sql'),
    );
    expect(sql).toContain("INSERT INTO development.schema_migrations (name) VALUES ('add_cleanup');");
    expect(sql).toContain('DELETE FROM development.crawlers');
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(sql).toContain("RAISE EXCEPTION 'tables the migrations create are missing from development: %'");
    expect(sql).not.toMatch(WRITES_TO_PUBLIC);
  });

  it('applies a file that was added before recorded ones', () => {
    expect(planDevelopment(files, ['create_users', 'create_deletions', 'add_cleanup'], false).applied).toEqual(['002_create_crawlers.sql']);
  });

  it('has nothing to run when every file is recorded', () => {
    expect(planDevelopment(files, files.map((each) => each.name), false)).toEqual({ sql: undefined, rebuilt: false, applied: [] });
  });

  it('fails and points at --reset when a recorded migration has no file', () => {
    expect(() => planDevelopment(files, ['create_users', 'removed_on_this_branch'], false)).toThrow(
      /records migrations that have no file: removed_on_this_branch\. Run again with --reset/,
    );
  });

  it('rebuilds from the first file with --reset, whatever is recorded', () => {
    const plan = planDevelopment(files, undefined, true);
    expect(plan.rebuilt).toBe(true);
    expect(plan.applied).toEqual(files.map((each) => each.fileName));
    const sql = plan.sql ?? '';
    const order = [
      'BEGIN;',
      'DROP SCHEMA IF EXISTS development CASCADE;',
      'CREATE SCHEMA development;',
      'GRANT USAGE ON SCHEMA development TO service_role;',
      'CREATE TABLE development.schema_migrations',
      '-- 001_create_users.sql',
      "VALUES ('create_users');",
      '-- 004_add_cleanup.sql',
      "VALUES ('add_cleanup');",
      "NOTIFY pgrst, 'reload schema';",
      'COMMIT;',
    ].map((text) => indexOf(sql, text));
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it('treats a missing schema as the first run, the same as --reset', () => {
    expect(planDevelopment(files, undefined, false)).toEqual(planDevelopment(files, undefined, true));
  });
});
