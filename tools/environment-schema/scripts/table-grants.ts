import { collectCreatedTables, NAME, QUALIFIER, storedName } from './created-tables.ts';
import { migrationNumber, type MigrationFile } from './migration-files.ts';
import { stripComments } from './sql-text.ts';

/**
 * The last migration whose tables got their privileges from Supabase, which
 * gave the Data API roles (anon, authenticated, service_role) privileges on
 * every new table in public. From 2026-10-30 Supabase stops doing that for
 * tables created in existing projects. Production's tables come from the
 * migrations up to this one, all applied before that date, and keep what they
 * got; a later migration has to grant its tables itself.
 */
export const LAST_MIGRATION_WITH_AUTOMATIC_GRANTS = 14;

/** Whether `file` is numbered up to {@link LAST_MIGRATION_WITH_AUTOMATIC_GRANTS}. A file without a number is treated as a later one. */
export function reliesOnAutomaticGrants(file: MigrationFile): boolean {
  const number = migrationNumber(file.fileName);
  return number !== undefined && number <= LAST_MIGRATION_WITH_AUTOMATIC_GRANTS;
}

const TABLE = `${QUALIFIER}${NAME}`;
// GRANT <privileges> ON [TABLE] <table>[, ...] TO <role>[, ...]. `ON FUNCTION f`,
// `ON SEQUENCE s` and `ON ALL TABLES IN SCHEMA x` do not read as a list of tables.
const TABLE_GRANT = new RegExp(
  String.raw`\bGRANT\s+(?<privileges>[^;]+?)\s+ON\s+(?:TABLE\s+)?(?<tables>${TABLE}(?:\s*,\s*${TABLE})*)\s+TO\s+(?<roles>[^;]+?)\s*(?:\bWITH\s+GRANT\s+OPTION\b|\bGRANTED\s+BY\b|;|$)`,
  'giu',
);
const LISTED_TABLE = new RegExp(TABLE, 'gu');
const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMPORARY|TEMP)\s+)?(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}`,
  'giu',
);
const DOLLAR_QUOTED = /\$([\p{L}_][\p{L}\p{N}_]*)?\$[\s\S]*?\$\1\$/gu;
const DO_BLOCK_START = /\bDO(?:\s+LANGUAGE\s+[\p{L}_][\p{L}\p{N}_]*)?\s*$/iu;

/**
 * Blanks the dollar-quoted bodies that only run when called (function and
 * procedure bodies), keeping DO blocks, which run when the file is applied.
 */
function blankUncalledBodies(code: string): string {
  return code.replace(DOLLAR_QUOTED, (body, _tag, offset: number) =>
    DO_BLOCK_START.test(code.slice(Math.max(0, offset - 60), offset)) ? body : ' '.repeat(body.length),
  );
}

/**
 * The tables `file` creates that no GRANT in the same file gives to
 * service_role, whatever the privileges. Only a GRANT that gives the table
 * itself counts: one that runs when the file is applied (at the top level or
 * in a DO block, not in a function body), without a column list (that grants
 * columns), and after the table is created (before, it fails).
 */
export function findTablesWithoutGrant(file: MigrationFile): string[] {
  const code = blankUncalledBodies(stripComments(file.sql));
  const createdAt = new Map<string, number>();
  for (const match of code.matchAll(CREATE_TABLE)) {
    const table = storedName(match[1]);
    if (!createdAt.has(table)) {
      createdAt.set(table, match.index);
    }
  }

  const granted = new Set<string>();
  for (const match of code.matchAll(TABLE_GRANT)) {
    const { privileges = '', tables = '', roles = '' } = match.groups ?? {};
    const roleNames = roles.split(',').map((role) => storedName(role.trim().replace(/^GROUP\s+/i, '')));
    if (privileges.includes('(') || !roleNames.includes('service_role')) {
      continue;
    }
    for (const table of tables.matchAll(LISTED_TABLE)) {
      const name = storedName(table[1]);
      if (match.index > (createdAt.get(name) ?? -1)) {
        granted.add(name);
      }
    }
  }
  return collectCreatedTables([file]).filter((table) => !granted.has(table));
}

/**
 * Throws, naming each file and table, when a migration numbered after
 * {@link LAST_MIGRATION_WITH_AUTOMATIC_GRANTS} creates a table without
 * granting it to service_role. Staging and development give such a table
 * nothing either, so the workers would fail there as in production; this
 * says so before any SQL is sent.
 */
export function assertTableGrants(files: MigrationFile[]): void {
  const ungranted = files
    .filter((file) => !reliesOnAutomaticGrants(file))
    .flatMap((file) => findTablesWithoutGrant(file).map((table) => ({ file: file.fileName, table })));
  if (ungranted.length === 0) {
    return;
  }

  const last = String(LAST_MIGRATION_WITH_AUTOMATIC_GRANTS).padStart(3, '0');
  throw new Error(
    [
      `migrations after ${last} create tables without a GRANT to service_role:`,
      ...ungranted.map(({ file, table }) => `  ${file}: ${table}`),
      `Supabase gives tables created from 2026-10-30 no Data API privileges, so the workers could not use them in production. Grant each table in the file that creates it, one GRANT per table, e.g. GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${ungranted[0].table} TO service_role; (GRANT ... ON ALL TABLES IN SCHEMA public is refused, since it names the public schema).`,
    ].join('\n'),
  );
}
