import { describe, it, expect } from 'vitest';
import configurationText from '../wrangler.toml?raw';

// What each environment of wrangler.toml has to say. wrangler does not inherit vars or bindings into an
// [env.*] block, so a block that forgets one runs without it, and a binding that still names a resource of
// production sends the data of staging or development there. A missing SUPABASE_SCHEMA is the worst of
// these: the client then reaches `public`, the tables of production.
// The names follow documents/2026-10-19-staging-environment.md. The ids of KV namespaces and D1 databases
// are not asserted, because they are filled in when the resource is created.

interface WorkerConfiguration {
  name?: string;
  vars?: Record<string, string>;
  worker_loaders?: Array<{ binding: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  services?: Array<{ binding: string; service: string }>;
  triggers?: { crons?: string[] };
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

function bindingOf<T extends { binding: string }>(list: T[] | undefined, binding: string): T | undefined {
  return list?.find((entry) => entry.binding === binding);
}

const EXPECTED: Record<EnvironmentName, { name: string; schema: string; origins: string; bucket: string; vault: string }> = {
  production: {
    name: 'audio-underview-crawler-manager-worker',
    schema: 'public',
    origins: 'https://audio-underview.pages.dev',
    bucket: 'audio-underview-crawler-files',
    vault: 'audio-underview-user-vault-worker',
  },
  staging: {
    name: 'audio-underview-crawler-manager-staging-worker',
    schema: 'staging',
    origins: 'https://staging.audio-underview.pages.dev',
    bucket: 'audio-underview-crawler-files-staging',
    vault: 'audio-underview-user-vault-staging-worker',
  },
  development: {
    name: 'audio-underview-crawler-manager-development-worker',
    schema: 'development',
    origins: 'https://development.audio-underview.pages.dev,https://localhost:5173',
    bucket: 'audio-underview-crawler-files-development',
    vault: 'audio-underview-user-vault-development-worker',
  },
  docker: {
    name: 'audio-underview-crawler-manager-docker-worker',
    schema: 'public',
    origins: 'https://localhost:5174',
    bucket: 'audio-underview-crawler-files-docker',
    vault: 'audio-underview-user-vault-docker-worker',
  },
};

// The resources an environment must not share with production (or with another environment)
function resourcesOf(name: EnvironmentName): Record<string, string | undefined> {
  const worker = configurationOf(name);
  return {
    'worker name': worker.name,
    'files bucket': bindingOf(worker.r2_buckets, 'CRAWLER_FILES')?.bucket_name,
    'vault worker': bindingOf(worker.services, 'USER_VAULT')?.service,
  };
}

describe('wrangler.toml environments', () => {
  it('defines staging, development and docker, and no other environment', () => {
    expect(Object.keys(configuration.env ?? {}).sort()).toEqual([...ENVIRONMENTS].sort());
  });

  describe.each(NAMES)('%s', (name) => {
    const expected = EXPECTED[name];

    it('sets its own name', () => {
      expect(configurationOf(name).name).toBe(expected.name);
    });

    it('sets SUPABASE_SCHEMA', () => {
      expect(configurationOf(name).vars?.SUPABASE_SCHEMA).toBe(expected.schema);
    });

    it('sets ALLOWED_ORIGINS', () => {
      expect(configurationOf(name).vars?.ALLOWED_ORIGINS).toBe(expected.origins);
    });

    it('repeats every variable of production and adds none', () => {
      expect(Object.keys(configurationOf(name).vars ?? {}).sort()).toEqual(Object.keys(configuration.vars ?? {}).sort());
    });

    it('has the loader, the bucket of its own and the vault of its own', () => {
      const worker = configurationOf(name);
      expect(bindingOf(worker.worker_loaders, 'LOADER')).toBeDefined();
      expect(bindingOf(worker.r2_buckets, 'CRAWLER_FILES')?.bucket_name).toBe(expected.bucket);
      expect(bindingOf(worker.services, 'USER_VAULT')?.service).toBe(expected.vault);
    });

    it('runs the cleanup cron, which is inherited', () => {
      expect(configurationOf(name).triggers?.crons ?? configuration.triggers?.crons).toEqual(['*/15 * * * *']);
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

  it('gives every environment a worker, a bucket and a vault of its own', () => {
    for (const kind of Object.keys(resourcesOf('production'))) {
      const values = NAMES.map((name) => resourcesOf(name)[kind]);
      expect(new Set(values).size, kind).toBe(values.length);
    }
  });
});
