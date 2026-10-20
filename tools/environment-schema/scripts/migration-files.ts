import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFile {
  /** e.g. `011_add_scheduled_runs.sql` */
  fileName: string;
  /** The name a migration is recorded under, e.g. `add_scheduled_runs`. */
  name: string;
  sql: string;
}

export interface MigrationPartition {
  /** Files production has applied, in number order. */
  applied: MigrationFile[];
  /** Files production has not applied yet, in number order. */
  pending: MigrationFile[];
  /** Names production has applied that no file here has, e.g. from a newer main. */
  appliedWithoutFile: string[];
}

/**
 * The file name without its number prefix and extension. Same rule as
 * `.github/workflows/deploy-database-migrations.yml` (`${filename#*_}`), which
 * records production's migrations under these names.
 */
export function migrationName(fileName: string): string {
  const base = fileName.replace(/\.sql$/, '');
  const separator = base.indexOf('_');
  return separator === -1 ? base : base.slice(separator + 1);
}

/** Files in number order. Two files with the same name could not be told apart in a migration history, so that throws. */
export function sortMigrationFiles(files: MigrationFile[]): MigrationFile[] {
  const sorted = [...files].sort((left, right) => left.fileName.localeCompare(right.fileName, 'en', { numeric: true }));
  const seen = new Map<string, string>();
  for (const file of sorted) {
    const other = seen.get(file.name);
    if (other !== undefined) {
      throw new Error(`${other} and ${file.fileName} have the same migration name ${file.name}`);
    }
    seen.set(file.name, file.fileName);
  }
  return sorted;
}

/** Every `*.sql` file of `directory`, in number order. */
export function readMigrationFiles(directory: string): MigrationFile[] {
  return sortMigrationFiles(
    readdirSync(directory)
      .filter((fileName) => fileName.endsWith('.sql'))
      .map((fileName) => ({ fileName, name: migrationName(fileName), sql: readFileSync(join(directory, fileName), 'utf8') })),
  );
}

/** Splits `files` (in number order) by whether production has applied them. */
export function partitionMigrations(files: MigrationFile[], appliedNames: Iterable<string>): MigrationPartition {
  const applied = new Set(appliedNames);
  const fileNames = new Set(files.map((file) => file.name));
  return {
    applied: files.filter((file) => applied.has(file.name)),
    pending: files.filter((file) => !applied.has(file.name)),
    appliedWithoutFile: [...applied].filter((name) => !fileNames.has(name)).sort(),
  };
}
