import { assertEnvironmentSchema } from './environments.ts';
import type { MigrationFile } from './migration-files.ts';
import { lineAt, stripComments } from './sql-text.ts';

// `public` used as a schema qualifier: before a dot (PostgreSQL allows spaces
// around it), and not the end of a longer word (`nonpublic.x`) or of a quoted
// identifier. Unquoted names fold to lower case, so `PUBLIC.users` is the same
// schema. The role keyword in `REVOKE ... FROM PUBLIC` has no dot after it and
// stays.
const UNQUOTED_QUALIFIER = /(?<![\p{L}\p{N}_$"])public(?=\s*\.)/giu;
// A quoted name keeps its case, so only `"public"` is the public schema.
const QUOTED_QUALIFIER = /"public"(?=\s*\.)/g;

/** `sql` with each `public.` (and `"public".`) schema qualifier replaced by `<schema>.`. */
export function rewriteSchemaQualifier(sql: string, schema: string): string {
  assertEnvironmentSchema(schema);
  return sql.replace(QUOTED_QUALIFIER, `"${schema}"`).replace(UNQUOTED_QUALIFIER, schema);
}

export interface SchemaEscape {
  line: number;
  reason: string;
}

const NOT_WORD_BEFORE = String.raw`(?<![\p{L}\p{N}_$])`;
const NOT_WORD_AFTER = String.raw`(?![\p{L}\p{N}_$])`;
// A quoted or plain name.
const NAME = String.raw`(?:"[^"\n]*"|[\p{L}_][\p{L}\p{N}_$]*)`;
// One element of a search_path list: a quoted name, a string, or a plain name.
const PATH_ELEMENT = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[\p{L}_][\p{L}\p{N}_$]*)`;
const PUBLIC_PATH_ELEMENT = String.raw`(?:${NOT_WORD_BEFORE}"?public"?${NOT_WORD_AFTER}|'[^'\n]*${NOT_WORD_BEFORE}public${NOT_WORD_AFTER}[^'\n]*')`;

// Where a statement can begin: a line start, a semicolon, or, in plpgsql, the
// body quote or keyword that opens a statement list.
const STATEMENT_START = String.raw`(?<=(?:^|;|\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$|${NOT_WORD_BEFORE}(?:THEN|ELSE|LOOP|BEGIN))\s*)`;
const STATEMENT_END = String.raw`\s*(?:;|$(?![\s\S]))`;
const TRANSACTION_WORD = String.raw`(?:\s+(?:WORK|TRANSACTION))?`;
const CHAIN = String.raw`(?:\s+AND\s+(?:NO\s+)?CHAIN)?`;
const TRANSACTION_MODE = String.raw`(?:ISOLATION\s+LEVEL\s+(?:SERIALIZABLE|REPEATABLE\s+READ|READ\s+COMMITTED|READ\s+UNCOMMITTED)|READ\s+(?:WRITE|ONLY)|(?:NOT\s+)?DEFERRABLE)`;
const TRANSACTION_MODES = String.raw`(?:(?:\s*,\s*|\s+)${TRANSACTION_MODE})*`;

// What a migration can do that the qualifier rewrite does not redirect. Applied
// to another schema, these would still change production, put public back on
// the search_path, or end the single transaction the run is applied in.
const ESCAPES: { pattern: RegExp; reason: string }[] = [
  {
    // `SCHEMA public`, also behind IF [NOT] EXISTS or later in a list of schemas.
    pattern: new RegExp(String.raw`\bSCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:${NAME}\s*,\s*)*"?public"?${NOT_WORD_AFTER}`, 'giu'),
    reason: 'names the public schema without a dot (SCHEMA public)',
  },
  {
    pattern: new RegExp(String.raw`\bsearch_path\s*(?:=|\bTO\b)\s*(?:${PATH_ELEMENT}\s*,\s*)*${PUBLIC_PATH_ELEMENT}`, 'giu'),
    reason: 'sets a search_path that includes public',
  },
  {
    pattern: new RegExp(String.raw`\bset_config\s*\(\s*'search_path'\s*,\s*'[^'\n]*${NOT_WORD_BEFORE}public${NOT_WORD_AFTER}`, 'giu'),
    reason: 'sets a search_path that includes public',
  },
  {
    // The value is an expression, not a plain string, so what it holds is unknown here.
    pattern: /\bset_config\s*\(\s*'search_path'\s*,(?!\s*'[^'\n]*'\s*,)/giu,
    reason: 'sets a search_path that is not a plain string, so it may include public',
  },
  {
    pattern: /\bUPDATE\s+(?:pg_catalog\s*\.\s*)?pg_settings\b/giu,
    reason: 'sets a setting such as the search_path through pg_settings',
  },
  {
    // The statement, and the RESET clause of ALTER FUNCTION, ALTER ROLE and ALTER DATABASE.
    pattern: new RegExp(String.raw`\bRESET\s+(?:ALL|search_path)${NOT_WORD_AFTER}`, 'giu'),
    reason: 'resets the search_path to its default, which includes public (RESET)',
  },
  {
    pattern: new RegExp(String.raw`\bsearch_path\s*(?:=|\bTO\b)\s*DEFAULT${NOT_WORD_AFTER}`, 'giu'),
    reason: 'sets the search_path to its default, which includes public (TO DEFAULT)',
  },
  {
    pattern: new RegExp(String.raw`\bDISCARD\s+(?:ALL|PLANS|SEQUENCES|TEMP|TEMPORARY)${NOT_WORD_AFTER}`, 'giu'),
    reason: 'discards session state the run relies on; DISCARD ALL also resets the search_path (DISCARD)',
  },
  {
    // Without IN SCHEMA the defaults cover objects created in every schema, public too.
    pattern: new RegExp(String.raw`\bALTER\s+DEFAULT\s+PRIVILEGES\s+(?:FOR\s+(?:ROLE|USER)\s+${NAME}(?:\s*,\s*${NAME})*\s+)?(?:GRANT|REVOKE)${NOT_WORD_AFTER}`, 'giu'),
    reason: 'changes default privileges in every schema, public included (ALTER DEFAULT PRIVILEGES without IN SCHEMA)',
  },
  {
    pattern: /\b(?:DROP|REASSIGN)\s+OWNED\s+BY\b/giu,
    reason: 'acts on objects in every schema, public included (DROP OWNED or REASSIGN OWNED)',
  },
  {
    // A plpgsql `END;` closes a block, not a transaction, so only END with a keyword counts.
    // `ROLLBACK TO SAVEPOINT` stays inside the transaction.
    pattern: new RegExp(
      String.raw`${STATEMENT_START}(?:BEGIN${TRANSACTION_WORD}${TRANSACTION_MODES}|START\s+TRANSACTION${TRANSACTION_MODES}|(?:COMMIT|ROLLBACK|ABORT)${TRANSACTION_WORD}${CHAIN}|END(?:\s+(?:WORK|TRANSACTION)${CHAIN}|\s+AND\s+(?:NO\s+)?CHAIN))${STATEMENT_END}`,
      'gimu',
    ),
    reason: 'controls the transaction itself',
  },
  {
    pattern: /\b(?:PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/giu,
    reason: 'controls the transaction itself',
  },
];

/**
 * The statements of a migration that would escape the schema or the
 * transaction it is applied in. Comments are ignored; string literals and
 * function bodies are read like the rest, so a match there counts too.
 */
export function findSchemaEscapes(sql: string): SchemaEscape[] {
  const code = stripComments(sql);
  return ESCAPES.flatMap(({ pattern, reason }) => [...code.matchAll(pattern)].map((match) => ({ line: lineAt(code, match.index), reason }))).sort(
    (left, right) => left.line - right.line,
  );
}

/**
 * The statements that apply `file` to `schema`: a search_path for the names it
 * leaves unqualified, then its SQL with `public.` qualifiers rewritten. Throws
 * when the file would escape the schema.
 */
export function migrationStatements(file: MigrationFile, schema: string): string {
  assertEnvironmentSchema(schema);
  const escapes = findSchemaEscapes(file.sql);
  if (escapes.length > 0) {
    throw new Error(
      `${file.fileName} cannot be applied to ${schema}:\n${escapes.map((escape) => `  line ${escape.line}: ${escape.reason}`).join('\n')}`,
    );
  }

  const body = rewriteSchemaQualifier(file.sql, schema).trimEnd();
  // A file whose last statement has no semicolon would run into the next statement.
  const terminated = stripComments(body).trimEnd().endsWith(';') ? body : `${body}\n;`;
  return [`-- ${file.fileName}`, `SET LOCAL search_path TO ${schema};`, terminated, ''].join('\n');
}
