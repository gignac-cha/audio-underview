import { describe, expect, it } from 'vitest';
import { orderByForeignKeys } from './foreign-key-order.ts';

describe('orderByForeignKeys', () => {
  it('puts every table after the tables it references', () => {
    const tables = ['accounts', 'crawler_files', 'crawlers', 'scheduler_runs', 'scheduler_stages', 'schedulers', 'task_groups', 'users'];
    const foreignKeys = [
      { table: 'accounts', references: 'users' },
      { table: 'crawlers', references: 'users' },
      { table: 'schedulers', references: 'users' },
      { table: 'scheduler_stages', references: 'schedulers' },
      { table: 'scheduler_stages', references: 'crawlers' },
      { table: 'scheduler_stages', references: 'task_groups' },
      { table: 'scheduler_runs', references: 'schedulers' },
      { table: 'crawler_files', references: 'scheduler_runs' },
      { table: 'crawler_files', references: 'crawlers' },
      { table: 'crawler_files', references: 'users' },
    ];
    const ordered = orderByForeignKeys(tables, foreignKeys);
    expect([...ordered].sort()).toEqual([...tables].sort());
    for (const { table, references } of foreignKeys) {
      expect(ordered.indexOf(table), `${table} after ${references}`).toBeGreaterThan(ordered.indexOf(references));
    }
  });

  it('keeps the given order where the keys leave a choice', () => {
    expect(orderByForeignKeys(['b', 'a', 'c'], [])).toEqual(['b', 'a', 'c']);
    expect(orderByForeignKeys(['child', 'parent', 'other'], [{ table: 'child', references: 'parent' }])).toEqual(['parent', 'child', 'other']);
  });

  it('allows a table that references itself', () => {
    expect(
      orderByForeignKeys(
        ['comments', 'users'],
        [
          { table: 'comments', references: 'comments' },
          { table: 'comments', references: 'users' },
        ],
      ),
    ).toEqual(['users', 'comments']);
  });

  it('ignores keys to tables it does not order', () => {
    expect(orderByForeignKeys(['a'], [{ table: 'a', references: 'elsewhere' }])).toEqual(['a']);
  });

  it('throws on a cycle and names it', () => {
    expect(() =>
      orderByForeignKeys(
        ['root', 'a', 'b', 'c', 'after'],
        [
          { table: 'a', references: 'root' },
          { table: 'a', references: 'c' },
          { table: 'b', references: 'a' },
          { table: 'c', references: 'b' },
          { table: 'after', references: 'c' },
        ],
      ),
    ).toThrow('foreign keys form a cycle: a -> c -> b -> a');
  });

  it('throws on a cycle of two', () => {
    expect(() =>
      orderByForeignKeys(
        ['a', 'b'],
        [
          { table: 'a', references: 'b' },
          { table: 'b', references: 'a' },
        ],
      ),
    ).toThrow('foreign keys form a cycle: a -> b -> a');
  });
});
