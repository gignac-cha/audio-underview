import type { MigrationFile } from './migration-files.ts';
import { stripComments } from './sql-text.ts';

// A table name, optionally qualified with `public` (the files' own schema).
// Names in other schemas (`pg_temp.x`) are not tables of the schema.
const QUALIFIER = String.raw`(?:(?:"public"|public)\s*\.\s*)?`;
const NAME = String.raw`("(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`;
const NAME_END = String.raw`(?![\p{L}\p{N}_$."])`;

const CREATE_TABLE = new RegExp(
  String.raw`\bCREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(TEMPORARY\s+|TEMP\s+)?(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIER}${NAME}${NAME_END}`,
  'giu',
);
const DROP_TABLE = new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)`, 'giu');
const RENAME_TABLE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIER}${NAME}\s+RENAME\s+TO\s+${NAME}${NAME_END}`,
  'giu',
);
const LISTED_NAME = new RegExp(String.raw`^\s*${QUALIFIER}${NAME}\s*$`, 'u');

/** A name as PostgreSQL stores it: unquoted names fold to lower case. */
function storedName(name: string): string {
  return name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.toLowerCase();
}

/**
 * The tables that exist after applying `files` in order: every table a file
 * creates, less those a later file drops, under their latest name.
 */
export function collectCreatedTables(files: MigrationFile[]): string[] {
  const tables = new Set<string>();

  for (const file of files) {
    const code = stripComments(file.sql);
    const events: { index: number; apply: () => void }[] = [];

    for (const match of code.matchAll(CREATE_TABLE)) {
      if (match[1] === undefined) {
        events.push({ index: match.index, apply: () => tables.add(storedName(match[2])) });
      }
    }
    for (const match of code.matchAll(DROP_TABLE)) {
      const names = match[1]
        .replace(/\s+(?:CASCADE|RESTRICT)\s*$/i, '')
        .split(',')
        .map((item) => LISTED_NAME.exec(item))
        .flatMap((listed) => (listed === null ? [] : [storedName(listed[1])]));
      events.push({ index: match.index, apply: () => names.forEach((name) => tables.delete(name)) });
    }
    for (const match of code.matchAll(RENAME_TABLE)) {
      events.push({
        index: match.index,
        apply: () => {
          if (tables.delete(storedName(match[1]))) {
            tables.add(storedName(match[2]));
          }
        },
      });
    }

    events.sort((left, right) => left.index - right.index).forEach((event) => event.apply());
  }

  return [...tables];
}
