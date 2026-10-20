import { describe, expect, it } from 'vitest';
import {
  buildEnvironmentSchema,
  DEVELOPMENT_RECORDS_QUERY,
  DEVELOPMENT_STATE_QUERY,
  formatSummary,
  parseProductionMetadata,
  PRODUCTION_METADATA_QUERY,
  type Row,
  type SchemaDatabase,
} from './environment-schema.ts';
import { migrationName, type MigrationFile } from './migration-files.ts';

const file = (fileName: string, sql: string): MigrationFile => ({ fileName, name: migrationName(fileName), sql });

const files = [
  file('001_create_users.sql', 'CREATE TABLE users (uuid UUID PRIMARY KEY);\n'),
  file('002_create_crawlers.sql', 'CREATE TABLE crawlers (id UUID PRIMARY KEY, user_uuid UUID REFERENCES users(uuid));\n'),
];

/** A database that answers from `answers` by query and records every call. */
function stubDatabase(productionNames: string[], answers: Map<string, Row[]>, writeAnswer: Row[] = []) {
  const calls: { sql: string; readOnly: boolean }[] = [];
  const database: SchemaDatabase = {
    async listProductionMigrationNames() {
      return productionNames;
    },
    async query(sql, options) {
      calls.push({ sql, readOnly: options?.readOnly === true });
      return answers.get(sql) ?? writeAnswer;
    },
  };
  return { database, calls };
}

describe('parseProductionMetadata', () => {
  it('reads parsed JSON and JSON text', () => {
    const expected = { tables: ['users'], foreignKeys: [{ table: 'crawlers', references: 'users' }] };
    expect(parseProductionMetadata([{ tables: ['users'], foreign_keys: [{ table: 'crawlers', references: 'users' }] }])).toEqual(expected);
    expect(parseProductionMetadata([{ tables: '["users"]', foreign_keys: '[{"table":"crawlers","references":"users"}]' }])).toEqual(expected);
  });

  it('rejects anything else', () => {
    expect(() => parseProductionMetadata([])).toThrow(/unexpected answer/);
    expect(() => parseProductionMetadata([{ tables: [1], foreign_keys: [] }])).toThrow(/unexpected answer/);
  });
});

describe('buildEnvironmentSchema', () => {
  const production = (tables: string[], foreignKeys: { table: string; references: string }[] = []) =>
    new Map([[PRODUCTION_METADATA_QUERY, [{ tables, foreign_keys: foreignKeys }]]]);

  it('reads production read-only, then runs the staging transaction once', async () => {
    const { database, calls } = stubDatabase(
      ['create_users', 'create_crawlers'],
      production(['crawlers', 'users'], [{ table: 'crawlers', references: 'users' }]),
      [
        { table_name: 'users', row_count: 3 },
        { table_name: 'crawlers', row_count: '5' },
      ],
    );
    const summary = await buildEnvironmentSchema({ environment: 'staging', reset: false, files, database });

    expect(calls.map((call) => call.readOnly)).toEqual([true, false]);
    expect(calls[1].sql).toContain('DROP SCHEMA IF EXISTS staging CASCADE;');
    expect(summary).toMatchObject({
      environment: 'staging',
      copiedRows: [
        { table: 'users', rows: 3 },
        { table: 'crawlers', rows: 5 },
      ],
    });
    expect(formatSummary(summary)).toEqual([
      'staging: rebuilt from production',
      '  migrations production has (2): 001_create_users.sql, 002_create_crawlers.sql',
      '  rows copied from production: users 3, crawlers 5',
      '  skipped, no migration production has creates them: none',
      '  not copied: none',
      '  migrations production does not have yet (0): none',
    ]);
  });

  it('lists the production tables no migration production has creates as skipped', async () => {
    const { database } = stubDatabase(['create_users'], production(['manual_notes', 'users']), [{ table_name: 'users', row_count: 3 }]);
    const summary = await buildEnvironmentSchema({ environment: 'staging', reset: false, files, database });

    expect(formatSummary(summary)).toEqual([
      'staging: rebuilt from production',
      '  migrations production has (1): 001_create_users.sql',
      '  rows copied from production: users 3',
      '  skipped, no migration production has creates them: manual_notes',
      '  not copied: none',
      '  migrations production does not have yet (1): 002_create_crawlers.sql',
    ]);
  });

  it.each([
    ['no rows', []],
    ['the rows of an earlier statement', [{ set_config: '' }]],
    ['rows for other tables', [{ table_name: 'crawlers', row_count: 5 }]],
    ['a count that is not a number', [{ table_name: 'users', row_count: null }]],
  ])('says the row counts are unknown when the run returns %s', async (_, writeAnswer) => {
    const { database } = stubDatabase(['create_users'], production(['users']), writeAnswer);
    const summary = await buildEnvironmentSchema({ environment: 'staging', reset: false, files, database });

    expect(summary).toMatchObject({ environment: 'staging', copiedRows: undefined });
    expect(formatSummary(summary)[2]).toBe('  rows copied from production: unknown, the run did not return its row counts');
  });

  it('builds staging on a production without tables or migrations', async () => {
    const { database, calls } = stubDatabase([], production([]), [{ set_config: '' }]);
    const summary = await buildEnvironmentSchema({ environment: 'staging', reset: false, files, database });

    expect(calls.map((call) => call.readOnly)).toEqual([true, false]);
    expect(formatSummary(summary).slice(1, 3)).toEqual(['  migrations production has (0): none', '  rows copied from production: none']);
  });

  it.each([
    ['production lists no migration but has tables', [], /lists no applied migration/],
    ['no name production lists has a file', ['001_create_users', '002_create_crawlers'], /none of the 2 migrations production lists has a file here/],
  ])('refuses before writing when %s', async (_, productionNames, message) => {
    const { database, calls } = stubDatabase(productionNames, production(['crawlers', 'users']));

    await expect(buildEnvironmentSchema({ environment: 'staging', reset: false, files, database })).rejects.toThrow(message);
    expect(calls.every((call) => call.readOnly)).toBe(true);
  });

  it('builds development from the first file when the schema does not exist', async () => {
    const { database, calls } = stubDatabase([], new Map([[DEVELOPMENT_STATE_QUERY, [{ schema_exists: false, records_exist: false }]]]));
    const summary = await buildEnvironmentSchema({ environment: 'development', reset: false, files, database });

    expect(calls.map((call) => call.readOnly)).toEqual([true, false]);
    expect(calls[1].sql).toContain('DROP SCHEMA IF EXISTS development CASCADE;');
    expect(formatSummary(summary)[0]).toBe('development: rebuilt from the first migration (first run), data removed');
  });

  it('applies only the new files to an existing development schema', async () => {
    const { database, calls } = stubDatabase(
      [],
      new Map([
        [DEVELOPMENT_STATE_QUERY, [{ schema_exists: true, records_exist: true }]],
        [DEVELOPMENT_RECORDS_QUERY, [{ name: 'create_users' }]],
      ]),
    );
    const summary = await buildEnvironmentSchema({ environment: 'development', reset: false, files, database });

    expect(calls.map((call) => call.sql.slice(0, 20))).toEqual([DEVELOPMENT_STATE_QUERY.slice(0, 20), DEVELOPMENT_RECORDS_QUERY.slice(0, 20), 'BEGIN;\n\nGRANT USAGE ']);
    expect(calls.slice(0, 2).every((call) => call.readOnly)).toBe(true);
    expect(formatSummary(summary)).toEqual(['development: kept its data and applied 1 new migration: 002_create_crawlers.sql']);
  });

  it('runs nothing when development is up to date', async () => {
    const { database, calls } = stubDatabase(
      [],
      new Map([
        [DEVELOPMENT_STATE_QUERY, [{ schema_exists: true, records_exist: true }]],
        [DEVELOPMENT_RECORDS_QUERY, [{ name: 'create_users' }, { name: 'create_crawlers' }]],
      ]),
    );
    const summary = await buildEnvironmentSchema({ environment: 'development', reset: false, files, database });

    expect(calls.every((call) => call.readOnly)).toBe(true);
    expect(formatSummary(summary)).toEqual(['development: up to date, nothing to apply']);
  });

  it('skips reading the records with --reset', async () => {
    const { database, calls } = stubDatabase([], new Map());
    const summary = await buildEnvironmentSchema({ environment: 'development', reset: true, files, database });

    expect(calls).toHaveLength(1);
    expect(calls[0].readOnly).toBe(false);
    expect(formatSummary(summary)[0]).toBe('development: rebuilt from the first migration (--reset), data removed');
  });

  it.each(['staging', 'development'] as const)('refuses %s before any query when a new migration does not grant its table', async (environment) => {
    const { database, calls } = stubDatabase(['create_users', 'create_crawlers'], production(['crawlers', 'users']));
    const ungranted = [...files, file('015_add_notes.sql', 'CREATE TABLE notes (id INT);\nGRANT SELECT ON notes TO anon;\n')];

    await expect(buildEnvironmentSchema({ environment, reset: false, files: ungranted, database })).rejects.toThrow(
      /^migrations after 014 create tables without a GRANT to service_role:\n {2}015_add_notes\.sql: notes\n/,
    );
    expect(calls).toEqual([]);
  });

  it('fails without writing when development exists but has no records', async () => {
    const { database, calls } = stubDatabase([], new Map([[DEVELOPMENT_STATE_QUERY, [{ schema_exists: true, records_exist: false }]]]));

    await expect(buildEnvironmentSchema({ environment: 'development', reset: false, files, database })).rejects.toThrow(/--reset/);
    expect(calls.every((call) => call.readOnly)).toBe(true);
  });
});
