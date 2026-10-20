import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationName, readMigrationFiles, type MigrationFile } from './migration-files.ts';
import { assertTableGrants, findTablesWithoutGrant, LAST_MIGRATION_WITH_AUTOMATIC_GRANTS, reliesOnAutomaticGrants } from './table-grants.ts';

const migrationsDirectory = fileURLToPath(new URL('../../../packages/supabase-connector/migrations', import.meta.url));

const file = (fileName: string, sql: string): MigrationFile => ({ fileName, name: migrationName(fileName), sql });
const later = (sql: string) => file('015_add_notes.sql', sql);

describe('reliesOnAutomaticGrants', () => {
  it('holds for the files up to 014 and not after', () => {
    expect(LAST_MIGRATION_WITH_AUTOMATIC_GRANTS).toBe(14);
    expect(reliesOnAutomaticGrants(file('001_create_users_and_accounts.sql', ''))).toBe(true);
    expect(reliesOnAutomaticGrants(file('014_add_crawler_test_runs.sql', ''))).toBe(true);
    expect(reliesOnAutomaticGrants(file('015_add_notes.sql', ''))).toBe(false);
    expect(reliesOnAutomaticGrants(file('20261019_add_notes.sql', ''))).toBe(false);
  });

  it('treats a file without a number as a later one', () => {
    expect(reliesOnAutomaticGrants(file('add_notes.sql', ''))).toBe(false);
  });
});

describe('findTablesWithoutGrant', () => {
  it.each([
    'CREATE TABLE notes (id INT);\nGRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO service_role;',
    'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes TO service_role;',
    'CREATE TABLE notes (id INT);\nGRANT ALL ON notes TO service_role;',
    'CREATE TABLE notes (id INT);\ngrant all privileges on table public.notes to anon, service_role with grant option;',
    'CREATE TABLE notes (id INT);\nGRANT SELECT ON "public" . "notes" TO "service_role";',
    'CREATE TABLE "Notes" (id INT);\nGRANT SELECT ON "Notes" TO authenticated, service_role;',
    'CREATE TABLE notes (id INT);\nCREATE TABLE tags (id INT);\nGRANT SELECT, INSERT ON TABLE notes, public.tags TO service_role;',
    'CREATE TABLE notes (id INT);\nDO LANGUAGE plpgsql $grant$\nBEGIN\n  GRANT ALL ON TABLE notes TO service_role;\nEND\n$grant$;',
    'CREATE TABLE notes (id INT);\nDO $$\nBEGIN\n  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = \'anon\') THEN\n    GRANT ALL ON TABLE notes TO service_role;\n  END IF;\nEND;\n$$;',
    'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes TO service_role GRANTED BY postgres;',
    'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes TO service_role',
  ])('accepts a per-table grant: %s', (sql) => {
    expect(findTablesWithoutGrant(later(sql))).toEqual([]);
  });

  it.each([
    ['no grant', 'CREATE TABLE notes (id INT);'],
    ['a grant to other roles only', 'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes TO anon, authenticated;'],
    ['a grant to PUBLIC', 'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes TO PUBLIC;'],
    ['a grant on every table of the schema', 'CREATE TABLE notes (id INT);\nGRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;'],
    ['a grant in a comment', 'CREATE TABLE notes (id INT);\n-- GRANT ALL ON TABLE notes TO service_role;\n/* GRANT ALL ON notes TO service_role; */'],
    ['a grant on a function of the same name', 'CREATE TABLE notes (id INT);\nGRANT EXECUTE ON FUNCTION notes() TO service_role;'],
    ['a grant on a sequence of the same name', 'CREATE TABLE notes (id INT);\nGRANT USAGE ON SEQUENCE notes TO service_role;'],
    ['a grant on a table of another schema', 'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE archive.notes TO service_role;'],
    ['a grant on another table', 'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE notes_archive TO service_role;'],
    ['a grant that keeps the case of a quoted name', 'CREATE TABLE notes (id INT);\nGRANT ALL ON TABLE "Notes" TO service_role;'],
    ['a revoke', 'CREATE TABLE notes (id INT);\nREVOKE ALL ON TABLE notes FROM service_role;'],
    ['a column grant only', 'CREATE TABLE notes (id INT);\nGRANT SELECT (id), UPDATE (id) ON TABLE notes TO service_role;'],
    ['a grant before the table is created', 'GRANT ALL ON TABLE notes TO service_role;\nCREATE TABLE notes (id INT);'],
    [
      'a grant only in a function body',
      "CREATE TABLE notes (id INT);\nCREATE FUNCTION grant_notes() RETURNS VOID LANGUAGE plpgsql AS $$\nBEGIN\n  GRANT ALL ON TABLE notes TO service_role;\nEND\n$$;",
    ],
  ])('finds the table with %s', (_, sql) => {
    expect(findTablesWithoutGrant(later(sql))).toEqual(['notes']);
  });

  it('names only the tables left without a grant', () => {
    expect(findTablesWithoutGrant(later('CREATE TABLE notes (id INT);\nCREATE TABLE tags (id INT);\nGRANT ALL ON TABLE tags TO service_role;'))).toEqual(['notes']);
  });

  it('needs no grant for a temporary table, a table the file drops again or one it only renames', () => {
    expect(
      findTablesWithoutGrant(
        later('CREATE TEMPORARY TABLE scratch (id INT);\nCREATE TABLE swap (id INT);\nDROP TABLE swap;\nALTER TABLE crawlers RENAME TO crawler_definitions;'),
      ),
    ).toEqual([]);
  });
});

describe('assertTableGrants', () => {
  it('passes the migrations, those after 014 granting the tables they create', () => {
    const files = readMigrationFiles(migrationsDirectory);
    expect(() => assertTableGrants(files)).not.toThrow();
    for (const each of files.filter((migration) => !reliesOnAutomaticGrants(migration))) {
      expect(findTablesWithoutGrant(each), each.fileName).toEqual([]);
    }
  });

  it('leaves the files up to 014 alone, which got their privileges from Supabase', () => {
    expect(() => assertTableGrants([file('013_add_crawler_runtime.sql', 'CREATE TABLE crawler_runs (id UUID);')])).not.toThrow();
  });

  it('names each file and table and says to grant per table', () => {
    let message = '';
    try {
      assertTableGrants([
        file('014_add_crawler_test_runs.sql', 'CREATE TABLE allowed (id INT);'),
        later('CREATE TABLE notes (id INT);\nCREATE TABLE tags (id INT);\nGRANT ALL ON TABLE tags TO service_role;'),
        file('016_add_labels.sql', 'CREATE TABLE labels (id INT);\nGRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;'),
      ]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^migrations after 014 create tables without a GRANT to service_role:\n {2}015_add_notes\.sql: notes\n {2}016_add_labels\.sql: labels\n/);
    expect(message).toContain('one GRANT per table, e.g. GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notes TO service_role;');
    expect(message).toContain('GRANT ... ON ALL TABLES IN SCHEMA public is refused');
    expect(message).not.toContain('allowed');
  });
});
