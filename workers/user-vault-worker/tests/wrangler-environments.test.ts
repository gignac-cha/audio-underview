import { describe, it, expect } from 'vitest';
import configurationText from '../wrangler.toml?raw';

// What each environment of wrangler.toml has to say. wrangler does not inherit vars into an [env.*] block,
// so a block that forgets SUPABASE_SCHEMA runs without one, and a block that still names public sends the
// data of staging or development to the tables of production.
// The vault keeps its tables in Supabase like the other workers, so no environment binds a D1 database.
// The names follow documents/2026-10-19-staging-environment.md.

interface WorkerConfiguration {
  name?: string;
  vars?: Record<string, string>;
  d1_databases?: unknown[];
  env?: Record<string, WorkerConfiguration>;
}

type Table = Record<string, unknown>;

// Reads the part of TOML that wrangler.toml uses: [table] and [[table array]] headers, and `key = value`
// lines whose value is also valid JSON (a string, a number, a boolean or an array of them). A line it cannot
// read throws, so a change of syntax cannot make a check pass by being skipped.
function parse(text: string): WorkerConfiguration {
  const root: Table = {};
  let current = root;
  for (const line of text.split('\n').map((line) => line.trim())) {
    if (line === '' || line.startsWith('#')) continue;
    const arrayHeader = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    const tableHeader = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    const header = arrayHeader ?? tableHeader;
    if (header !== null) {
      const path = header[1].split('.');
      const parent = path.slice(0, -1).reduce<Table>((table, key) => (table[key] ??= {}) as Table, root);
      const last = path[path.length - 1];
      if (arrayHeader !== null) {
        current = {};
        ((parent[last] ??= []) as Table[]).push(current);
      } else {
        current = (parent[last] ??= {}) as Table;
      }
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_]+) = (.+?)\s*(?:#.*)?$/);
    if (entry === null) throw new Error(`Cannot read this line of wrangler.toml: ${line}`);
    current[entry[1]] = JSON.parse(entry[2]);
  }
  return root as WorkerConfiguration;
}

const configuration = parse(configurationText);

const ENVIRONMENTS = ['staging', 'development', 'docker'] as const;
const NAMES = ['production', ...ENVIRONMENTS] as const;
type EnvironmentName = (typeof NAMES)[number];

function configurationOf(name: EnvironmentName): WorkerConfiguration {
  if (name === 'production') return configuration;
  const found = configuration.env?.[name];
  if (found === undefined) throw new Error(`wrangler.toml has no [env.${name}]`);
  return found;
}

const EXPECTED: Record<EnvironmentName, { name: string; schema: string }> = {
  production: { name: 'audio-underview-user-vault-worker', schema: 'public' },
  staging: { name: 'audio-underview-user-vault-staging-worker', schema: 'staging' },
  development: { name: 'audio-underview-user-vault-development-worker', schema: 'development' },
  docker: { name: 'audio-underview-user-vault-docker-worker', schema: 'public' },
};

// The resources an environment must not share with production (or with another environment)
function resourcesOf(name: EnvironmentName): Record<string, string | undefined> {
  return { 'worker name': configurationOf(name).name };
}

describe('wrangler.toml environments', () => {
  it('defines staging, development and docker, and no other environment', () => {
    expect(Object.keys(configuration.env ?? {}).sort()).toEqual([...ENVIRONMENTS].sort());
  });

  it('binds no D1 database anywhere', () => {
    expect(configurationText).not.toMatch(/d1_databases/);
    for (const name of NAMES) {
      expect(configurationOf(name).d1_databases, name).toBeUndefined();
    }
  });

  describe.each(NAMES)('%s', (name) => {
    const expected = EXPECTED[name];

    it('sets its own name', () => {
      expect(configurationOf(name).name).toBe(expected.name);
    });

    it('sets SUPABASE_SCHEMA', () => {
      expect(configurationOf(name).vars?.SUPABASE_SCHEMA).toBe(expected.schema);
    });

    it('sets PROVIDER_KEY_KEK_VERSION', () => {
      expect(configurationOf(name).vars?.PROVIDER_KEY_KEK_VERSION).toBe('1');
    });

    it('repeats every variable of production and adds none', () => {
      expect(Object.keys(configurationOf(name).vars ?? {}).sort()).toEqual(Object.keys(configuration.vars ?? {}).sort());
    });
  });

  it.each(['staging', 'development'] as const)('%s does not use the schema of production', (name) => {
    expect(configurationOf(name).vars?.SUPABASE_SCHEMA).toBeTypeOf('string');
    expect(configurationOf(name).vars?.SUPABASE_SCHEMA).not.toBe(configuration.vars?.SUPABASE_SCHEMA);
  });

  it.each(ENVIRONMENTS)('%s repeats no resource of production', (name) => {
    const production = resourcesOf('production');
    for (const [kind, value] of Object.entries(resourcesOf(name))) {
      expect(value, kind).toBeTypeOf('string');
      expect(value, kind).not.toBe(production[kind]);
    }
  });

  it('gives every environment a worker of its own', () => {
    for (const kind of Object.keys(resourcesOf('production'))) {
      const values = NAMES.map((name) => resourcesOf(name)[kind]);
      expect(new Set(values).size, kind).toBe(values.length);
    }
  });
});
