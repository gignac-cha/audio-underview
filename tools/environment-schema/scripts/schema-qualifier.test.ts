import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readMigrationFiles } from './migration-files.ts';
import { findSchemaEscapes, migrationStatements, rewriteSchemaQualifier } from './schema-qualifier.ts';

const files = readMigrationFiles(fileURLToPath(new URL('../../../packages/supabase-connector/migrations', import.meta.url)));

describe('rewriteSchemaQualifier', () => {
  it.each([
    ['UPDATE public.schedulers SET x = 1', 'UPDATE staging.schedulers SET x = 1'],
    ['INSERT INTO public.crawler_file_deletions (object_key)', 'INSERT INTO staging.crawler_file_deletions (object_key)'],
    ['SELECT id FROM public.crawler_files', 'SELECT id FROM staging.crawler_files'],
    ['DELETE FROM PUBLIC.users', 'DELETE FROM staging.users'],
    ['ALTER TABLE Public.users ADD x INT', 'ALTER TABLE staging.users ADD x INT'],
    ['SELECT * FROM "public"."users"', 'SELECT * FROM "staging"."users"'],
    ['SELECT * FROM "public".users', 'SELECT * FROM "staging".users'],
    ['SELECT * FROM public."Users"', 'SELECT * FROM staging."Users"'],
    ["SELECT 'google'::public.provider_type", "SELECT 'google'::staging.provider_type"],
    ['(public.a, public.b)', '(staging.a, staging.b)'],
    ['SELECT * FROM public . users', 'SELECT * FROM staging . users'],
    ['CREATE TABLE "public" . "leak" (id INT)', 'CREATE TABLE "staging" . "leak" (id INT)'],
  ])('rewrites %s', (sql, expected) => {
    expect(rewriteSchemaQualifier(sql, 'staging')).toBe(expected);
  });

  it.each([
    'REVOKE EXECUTE ON FUNCTION f(JSONB) FROM PUBLIC;',
    'GRANT SELECT ON users TO public;',
    'SELECT * FROM nonpublic.users',
    'SELECT * FROM republic.users',
    'SELECT * FROM my_public.users',
    'SELECT * FROM public_data.users',
    'SELECT * FROM "Public".users',
    'SELECT * FROM "not public".users',
    'SELECT * FROM pg_temp.round_schedule_minutes(x)',
    '-- The public anon and authenticated keys must not change scheduling data.',
  ])('leaves %s alone', (sql) => {
    expect(rewriteSchemaQualifier(sql, 'staging')).toBe(sql);
  });

  it('rewrites the function bodies of the migrations and keeps the role keyword', () => {
    for (const file of files) {
      const rewritten = rewriteSchemaQualifier(file.sql, 'development');
      expect(rewritten, file.fileName).not.toMatch(/(?<![\p{L}\p{N}_$"])"?public"?\s*\./iu);
      expect(rewritten.match(/FROM PUBLIC;/g)?.length ?? 0, file.fileName).toBe(file.sql.match(/FROM PUBLIC;/g)?.length ?? 0);
    }
    const scheduledRuns = files.find((file) => file.name === 'add_scheduled_runs');
    expect(rewriteSchemaQualifier(scheduledRuns?.sql ?? '', 'staging')).toContain('UPDATE staging.scheduler_runs');
  });

  it('refuses to write anywhere but staging and development', () => {
    expect(() => rewriteSchemaQualifier('SELECT 1', 'public')).toThrow(/refusing/);
    expect(() => rewriteSchemaQualifier('SELECT 1', 'prototype')).toThrow(/refusing/);
  });
});

describe('findSchemaEscapes', () => {
  it('finds statements that name the public schema without a dot', () => {
    expect(findSchemaEscapes('SELECT 1;\nGRANT USAGE ON SCHEMA public TO anon;')).toEqual([{ line: 2, reason: 'names the public schema without a dot (SCHEMA public)' }]);
    expect(findSchemaEscapes('ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT ALL ON TABLES TO anon;')).toHaveLength(1);
  });

  it('finds search paths that include public', () => {
    for (const sql of [
      'SET search_path = public;',
      'SET search_path TO "$user", public;',
      'CREATE FUNCTION f() RETURNS INT LANGUAGE sql SET search_path = public, extensions AS $$ SELECT 1 $$;',
      "SELECT set_config('search_path', 'public', true);",
      "SET search_path = 'public';",
    ]) {
      expect(findSchemaEscapes(sql), sql).toHaveLength(1);
    }
  });

  it('allows an empty search_path followed by a body that uses public.', () => {
    expect(findSchemaEscapes("CREATE FUNCTION f() RETURNS INT\nLANGUAGE sql\nSET search_path = ''\nAS $$\n  SELECT count(*) FROM public.users;\n$$;")).toEqual([]);
  });

  it('finds transaction control but not plpgsql blocks', () => {
    expect(findSchemaEscapes('BEGIN;\nCREATE TABLE a (id INT);\nCOMMIT;').map((escape) => escape.line)).toEqual([1, 3]);
    expect(findSchemaEscapes('DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;')).toEqual([]);
  });

  it.each([
    ['RESET search_path;', 'resets the search_path to its default, which includes public (RESET)'],
    ['RESET ALL;', 'resets the search_path to its default, which includes public (RESET)'],
    ['ALTER FUNCTION f() RESET search_path;', 'resets the search_path to its default, which includes public (RESET)'],
    ['ALTER ROLE authenticated RESET ALL;', 'resets the search_path to its default, which includes public (RESET)'],
    ["DO $$ BEGIN EXECUTE 'RESET search_path'; END $$;", 'resets the search_path to its default, which includes public (RESET)'],
    ['SET search_path TO DEFAULT;', 'sets the search_path to its default, which includes public (TO DEFAULT)'],
    ['SET search_path = default;', 'sets the search_path to its default, which includes public (TO DEFAULT)'],
    ['SET SESSION search_path TO DEFAULT;', 'sets the search_path to its default, which includes public (TO DEFAULT)'],
    ['SET LOCAL search_path = DEFAULT;', 'sets the search_path to its default, which includes public (TO DEFAULT)'],
    ['ALTER FUNCTION f() SET search_path TO DEFAULT;', 'sets the search_path to its default, which includes public (TO DEFAULT)'],
    ['DISCARD ALL;', 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)'],
    ['DISCARD PLANS;', 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)'],
    ['DISCARD SEQUENCES;', 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)'],
    ['DISCARD TEMP;', 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)'],
    ['DISCARD TEMPORARY;', 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)'],
    [
      "SELECT set_config('search_path', current_setting('search_path') || ', public', true);",
      'sets a search_path that is not a plain string, so it may include public',
    ],
    ["UPDATE pg_settings SET setting = 'public' WHERE name = 'search_path';", 'sets a setting such as the search_path through pg_settings'],
    ["UPDATE pg_catalog.pg_settings SET setting = 'public' WHERE name = 'search_path';", 'sets a setting such as the search_path through pg_settings'],
    [
      'ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon;',
      'changes default privileges in every schema, public included (ALTER DEFAULT PRIVILEGES without IN SCHEMA)',
    ],
    [
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres, "Other Role" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;',
      'changes default privileges in every schema, public included (ALTER DEFAULT PRIVILEGES without IN SCHEMA)',
    ],
    ['DROP OWNED BY anon;', 'acts on objects in every schema, public included (DROP OWNED or REASSIGN OWNED)'],
    ['REASSIGN OWNED BY anon TO postgres;', 'acts on objects in every schema, public included (DROP OWNED or REASSIGN OWNED)'],
    ['DROP SCHEMA IF EXISTS public CASCADE;', 'names the public schema without a dot (SCHEMA public)'],
    ['CREATE SCHEMA IF NOT EXISTS public;', 'names the public schema without a dot (SCHEMA public)'],
    ['GRANT USAGE ON SCHEMA extensions, public TO anon;', 'names the public schema without a dot (SCHEMA public)'],
    ['COMMIT AND CHAIN;', 'controls the transaction itself'],
    ['COMMIT AND NO CHAIN;', 'controls the transaction itself'],
    ['ROLLBACK AND CHAIN;', 'controls the transaction itself'],
    ['COMMIT WORK;', 'controls the transaction itself'],
    ['ROLLBACK TRANSACTION AND CHAIN;', 'controls the transaction itself'],
    ['ABORT;', 'controls the transaction itself'],
    ['END AND CHAIN;', 'controls the transaction itself'],
    ['END TRANSACTION AND NO CHAIN;', 'controls the transaction itself'],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE;', 'controls the transaction itself'],
    ['START TRANSACTION READ ONLY;', 'controls the transaction itself'],
    ['SELECT 1; COMMIT;', 'controls the transaction itself'],
    ['CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN IF true THEN COMMIT; END IF; END $$;', 'controls the transaction itself'],
    ["PREPARE TRANSACTION 'staging';", 'controls the transaction itself'],
    ["COMMIT PREPARED 'staging';", 'controls the transaction itself'],
    ["ROLLBACK PREPARED 'staging';", 'controls the transaction itself'],
  ])('finds %s', (sql, reason) => {
    expect(findSchemaEscapes(`SELECT 1;\n${sql}`)).toEqual([{ line: 2, reason }]);
  });

  it.each([
    "SET search_path TO 'default';",
    "SELECT set_config('search_path', '', true);",
    "SELECT set_config( 'search_path' , 'staging' , true);",
    'RESET ROLE;',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA extensions GRANT ALL ON TABLES TO anon;',
    'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT ALL ON TABLES TO anon;',
    'DROP TABLE owned_items;',
    'ROLLBACK TO SAVEPOINT before_copy;',
    'CREATE TEMPORARY TABLE t (id INT) ON COMMIT DROP;',
    'CREATE TEMPORARY TABLE t (id INT) ON\nCOMMIT PRESERVE ROWS;',
    'DO $$\nBEGIN\n  IF true THEN\n    PERFORM 1;\n  END IF;\nEND;\n$$;',
    'CREATE SCHEMA IF NOT EXISTS extensions;',
    'CREATE TABLE crawlers (input_schema JSONB, settings_schema JSONB);',
  ])('allows %s', (sql) => {
    expect(findSchemaEscapes(sql)).toEqual([]);
  });

  it('ignores comments', () => {
    expect(findSchemaEscapes('-- GRANT USAGE ON SCHEMA public TO anon;\n/* SET search_path = public; */\nSELECT 1;')).toEqual([]);
  });

  it('finds nothing in the migrations', () => {
    for (const file of files) {
      expect(findSchemaEscapes(file.sql), file.fileName).toEqual([]);
    }
  });
});

describe('migrationStatements', () => {
  const file = (sql: string) => ({ fileName: '015_add_x.sql', name: 'add_x', sql });

  it('sets the search path, rewrites qualifiers and labels the file', () => {
    expect(migrationStatements(file('CREATE TABLE x (id INT);\nUPDATE public.x SET id = 1;\n'), 'staging')).toBe(
      '-- 015_add_x.sql\nSET LOCAL search_path TO staging;\nCREATE TABLE x (id INT);\nUPDATE staging.x SET id = 1;\n',
    );
  });

  it('terminates a last statement that has no semicolon, even behind a comment', () => {
    expect(migrationStatements(file('CREATE TABLE x (id INT) -- no semicolon'), 'staging')).toMatch(/-- no semicolon\n;\n$/);
  });

  it('refuses a file that would escape the schema', () => {
    expect(() => migrationStatements(file('CREATE TABLE x (id INT);\nGRANT ALL ON SCHEMA public TO anon;'), 'staging')).toThrow(
      /015_add_x.sql cannot be applied to staging:\n {2}line 2: names the public schema/,
    );
  });
});
