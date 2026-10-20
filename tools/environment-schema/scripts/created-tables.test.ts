import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectCreatedTables } from './created-tables.ts';
import { readMigrationFiles } from './migration-files.ts';

const file = (sql: string) => ({ fileName: '001_x.sql', name: 'x', sql });

describe('collectCreatedTables', () => {
  it('lists the twelve tables of the migrations', () => {
    const files = readMigrationFiles(fileURLToPath(new URL('../../../packages/supabase-connector/migrations', import.meta.url)));
    expect(collectCreatedTables(files).sort()).toEqual([
      'accounts',
      'crawler_file_deletions',
      'crawler_files',
      'crawler_permissions',
      'crawler_runs',
      'crawlers',
      'scheduler_runs',
      'scheduler_stage_runs',
      'scheduler_stages',
      'schedulers',
      'task_groups',
      'users',
    ]);
  });

  it('reads qualified, quoted and IF NOT EXISTS forms', () => {
    expect(
      collectCreatedTables([file('CREATE TABLE public.a (id INT);\nCREATE TABLE IF NOT EXISTS "public"."B" (id INT);\ncreate unlogged table Cee (id INT);')]),
    ).toEqual(['a', 'B', 'cee']);
  });

  it('skips temporary tables, tables of other schemas and comments', () => {
    expect(
      collectCreatedTables([file('CREATE TEMP TABLE t (id INT);\nCREATE TABLE pg_temp.u (id INT);\n-- CREATE TABLE commented (id INT);\nCREATE TABLE kept (id INT);')]),
    ).toEqual(['kept']);
  });

  it('follows drops and renames across files in order', () => {
    expect(
      collectCreatedTables([
        file('CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\nCREATE TABLE c (id INT);'),
        file('DROP TABLE IF EXISTS public.a, b CASCADE;\nALTER TABLE IF EXISTS c RENAME TO d;'),
        file('CREATE TABLE a (id INT);'),
      ]).sort(),
    ).toEqual(['a', 'd']);
  });
});
