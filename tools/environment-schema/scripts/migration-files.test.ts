import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationName, partitionMigrations, readMigrationFiles, sortMigrationFiles, type MigrationFile } from './migration-files.ts';

const migrationsDirectory = fileURLToPath(new URL('../../../packages/supabase-connector/migrations', import.meta.url));

const file = (fileName: string): MigrationFile => ({ fileName, name: migrationName(fileName), sql: `-- ${fileName}\n` });

describe('migrationName', () => {
  it('drops the number prefix and the extension, like the migration workflow', () => {
    expect(migrationName('011_add_scheduled_runs.sql')).toBe('add_scheduled_runs');
    expect(migrationName('001_create_users_and_accounts.sql')).toBe('create_users_and_accounts');
    expect(migrationName('20261019_add_x.sql')).toBe('add_x');
    expect(migrationName('nounderscore.sql')).toBe('nounderscore');
  });
});

describe('sortMigrationFiles', () => {
  it('orders by number', () => {
    expect(sortMigrationFiles([file('10_c.sql'), file('9_b.sql'), file('001_a.sql')]).map((each) => each.fileName)).toEqual(['001_a.sql', '9_b.sql', '10_c.sql']);
  });

  it('rejects two files with the same name', () => {
    expect(() => sortMigrationFiles([file('001_same.sql'), file('002_same.sql')])).toThrow(/001_same.sql and 002_same.sql have the same migration name same/);
  });
});

describe('readMigrationFiles', () => {
  it('reads the connector migrations in number order', () => {
    const files = readMigrationFiles(migrationsDirectory);
    expect(files[0].fileName).toBe('001_create_users_and_accounts.sql');
    expect(files.map((each) => each.fileName)).toEqual([...files.map((each) => each.fileName)].sort());
    expect(files.find((each) => each.name === 'add_scheduled_runs')?.sql).toContain('fail_scheduler_runs');
  });
});

describe('partitionMigrations', () => {
  const files = ['001_create_users.sql', '002_create_crawlers.sql', '003_add_type.sql', '004_add_runs.sql'].map(file);

  it('splits by production-applied names and keeps number order on both sides', () => {
    const partition = partitionMigrations(files, ['create_crawlers', 'create_users']);
    expect(partition.applied.map((each) => each.fileName)).toEqual(['001_create_users.sql', '002_create_crawlers.sql']);
    expect(partition.pending.map((each) => each.fileName)).toEqual(['003_add_type.sql', '004_add_runs.sql']);
    expect(partition.appliedWithoutFile).toEqual([]);
  });

  it('matches by name, not by number, and reports applied names without a file', () => {
    const partition = partitionMigrations(files, ['create_users', 'add_runs', 'add_from_newer_main']);
    expect(partition.applied.map((each) => each.fileName)).toEqual(['001_create_users.sql', '004_add_runs.sql']);
    expect(partition.pending.map((each) => each.fileName)).toEqual(['002_create_crawlers.sql', '003_add_type.sql']);
    expect(partition.appliedWithoutFile).toEqual(['add_from_newer_main']);
  });

  it('treats everything as pending when production has nothing', () => {
    expect(partitionMigrations(files, []).pending).toHaveLength(4);
  });
});
