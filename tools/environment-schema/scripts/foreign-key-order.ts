/** A foreign key of `table` that references `references`, as `pg_constraint` lists it. */
export interface ForeignKey {
  table: string;
  references: string;
}

/**
 * `tables` ordered so that each comes after every table it references, keeping
 * the given order where the keys leave a choice. A table that references
 * itself is fine: the rows of one `INSERT ... SELECT` are checked after all of
 * them are in. Keys to tables outside `tables` are ignored. Throws on a cycle,
 * since no order would satisfy it.
 */
export function orderByForeignKeys(givenTables: string[], foreignKeys: ForeignKey[]): string[] {
  const tables = [...new Set(givenTables)];
  const included = new Set(tables);
  const dependencies = new Map(tables.map((table) => [table, new Set<string>()]));
  for (const { table, references } of foreignKeys) {
    if (table !== references && included.has(table) && included.has(references)) {
      dependencies.get(table)?.add(references);
    }
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < tables.length) {
    const next = tables.find((table) => !placed.has(table) && [...(dependencies.get(table) ?? [])].every((dependency) => placed.has(dependency)));
    if (next === undefined) {
      throw new Error(`foreign keys form a cycle: ${findCycle(tables.filter((table) => !placed.has(table)), dependencies).join(' -> ')}`);
    }
    ordered.push(next);
    placed.add(next);
  }
  return ordered;
}

/** One cycle among `remaining`, each of which still waits for another of them. */
function findCycle(remaining: string[], dependencies: Map<string, Set<string>>): string[] {
  const waiting = new Set(remaining);
  const path: string[] = [];
  let current = remaining[0];
  while (!path.includes(current)) {
    path.push(current);
    current = [...(dependencies.get(current) ?? [])].find((dependency) => waiting.has(dependency)) as string;
  }
  return [...path.slice(path.indexOf(current)), current];
}
