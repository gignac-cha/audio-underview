/**
 * `sql` with every comment replaced by spaces, so positions and line numbers
 * stay the same. String literals, quoted identifiers and dollar-quoted bodies
 * are kept as they are, so a `--` inside function code is not a comment.
 */
export function stripComments(sql: string): string {
  let result = '';
  let index = 0;

  const blank = (text: string) => text.replace(/[^\n]/g, ' ');

  while (index < sql.length) {
    const rest = sql.slice(index);

    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      result += blank(sql.slice(index, stop));
      index = stop;
      continue;
    }

    if (rest.startsWith('/*')) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      let position = index;
      while (position < sql.length) {
        if (sql.startsWith('/*', position)) {
          depth += 1;
          position += 2;
        } else if (sql.startsWith('*/', position)) {
          depth -= 1;
          position += 2;
          if (depth === 0) {
            break;
          }
        } else {
          position += 1;
        }
      }
      result += blank(sql.slice(index, position));
      index = position;
      continue;
    }

    const dollarTag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(rest);
    if (dollarTag !== null && !/[\p{L}\p{N}_$]/u.test(sql[index - 1] ?? '')) {
      const close = sql.indexOf(dollarTag[0], index + dollarTag[0].length);
      const stop = close === -1 ? sql.length : close + dollarTag[0].length;
      result += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (sql[index] === "'" || sql[index] === '"') {
      const quote = sql[index];
      // E'...' strings also escape with a backslash.
      const backslashEscapes = quote === "'" && /[eE]/.test(sql[index - 1] ?? '') && !/[\p{L}\p{N}_$]/u.test(sql[index - 2] ?? '');
      let position = index + 1;
      while (position < sql.length) {
        if (backslashEscapes && sql[position] === '\\') {
          position += 2;
        } else if (sql[position] === quote && sql[position + 1] === quote) {
          position += 2;
        } else if (sql[position] === quote) {
          position += 1;
          break;
        } else {
          position += 1;
        }
      }
      result += sql.slice(index, position);
      index = position;
      continue;
    }

    result += sql[index];
    index += 1;
  }

  return result;
}

/** The 1-based line of `index` in `text`. */
export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** `value` as a SQL string literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
