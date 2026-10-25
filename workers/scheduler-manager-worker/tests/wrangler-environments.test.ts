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
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  workflows?: Array<{ binding: string; name: string; class_name: string }>;
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

// The cron is inherited unless the environment sets its own
function cronsOf(name: EnvironmentName): string[] | undefined {
  return configurationOf(name).triggers?.crons ?? configuration.triggers?.crons;
}

const EXPECTED: Record<EnvironmentName, { name: string; schema: string; origins: string; crawlerManager: string; newscast: string; workflow: string; crons: string[] }> = {
  production: {
    name: 'audio-underview-scheduler-manager-worker',
    schema: 'public',
    origins: 'https://audio-underview.pages.dev',
    crawlerManager: 'audio-underview-crawler-manager-worker',
    newscast: 'audio-underview-newscast-worker',
    workflow: 'audio-underview-scheduler-run-workflow',
    crons: ['*/10 * * * *'],
  },
  // The tick is off: the copied production schedules would run a second time in staging
  staging: {
    name: 'audio-underview-scheduler-manager-staging-worker',
    schema: 'staging',
    origins: 'https://staging.audio-underview.pages.dev',
    crawlerManager: 'audio-underview-crawler-manager-staging-worker',
    newscast: 'audio-underview-newscast-staging-worker',
    workflow: 'audio-underview-scheduler-run-staging-workflow',
    crons: [],
  },
  development: {
    name: 'audio-underview-scheduler-manager-development-worker',
    schema: 'development',
    origins: 'https://development.audio-underview.pages.dev,https://localhost:5173',
    crawlerManager: 'audio-underview-crawler-manager-development-worker',
    newscast: 'audio-underview-newscast-development-worker',
    workflow: 'audio-underview-scheduler-run-development-workflow',
    crons: ['*/10 * * * *'],
  },
  docker: {
    name: 'audio-underview-scheduler-manager-docker-worker',
    schema: 'public',
    origins: 'https://localhost:5174',
    crawlerManager: 'audio-underview-crawler-manager-docker-worker',
    newscast: 'audio-underview-newscast-docker-worker',
    workflow: 'audio-underview-scheduler-run-docker-workflow',
    crons: ['*/10 * * * *'],
  },
};

// The resources an environment must not share with production (or with another environment)
function resourcesOf(name: EnvironmentName): Record<string, string | undefined> {
  const worker = configurationOf(name);
  return {
    'worker name': worker.name,
    'crawler manager worker': bindingOf(worker.services, 'CRAWLER_MANAGER')?.service,
    'newscast worker': bindingOf(worker.services, 'NEWSCAST')?.service,
    'workflow name': bindingOf(worker.workflows, 'SCHEDULER_RUN_WORKFLOW')?.name,
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

    it('calls the crawler manager of its own environment', () => {
      expect(bindingOf(configurationOf(name).services, 'CRAWLER_MANAGER')?.service).toBe(expected.crawlerManager);
    });

    // The group stage calls startTaskGroupRun on the binding, so it has to name the entrypoint that has it
    it('starts newscasts through the task group entrypoint of the newscast worker of its own environment', () => {
      const binding = bindingOf(configurationOf(name).services, 'NEWSCAST');
      expect(binding?.service).toBe(expected.newscast);
      expect(binding?.entrypoint).toBe('NewscastTaskGroup');
    });

    it('runs scheduled runs in the workflow of its own environment, with the same class', () => {
      const workflow = bindingOf(configurationOf(name).workflows, 'SCHEDULER_RUN_WORKFLOW');
      expect(workflow?.name).toBe(expected.workflow);
      expect(workflow?.class_name).toBe(bindingOf(configuration.workflows, 'SCHEDULER_RUN_WORKFLOW')?.class_name);
    });

    it('ticks on the cron rule of its environment', () => {
      expect(cronsOf(name)).toEqual(expected.crons);
    });
  });

  it('turns the tick off in staging by setting crons to an empty list, because [triggers] is inherited', () => {
    expect(configurationOf('staging').triggers).toEqual({ crons: [] });
  });

  it.each(['development', 'docker'] as const)('%s inherits the cron rule of production', (name) => {
    expect(configurationOf(name).triggers).toBeUndefined();
    expect(cronsOf(name)).toEqual(configuration.triggers?.crons);
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

  it('gives every environment a worker, a crawler manager, a newscast worker and a workflow of its own', () => {
    for (const kind of Object.keys(resourcesOf('production'))) {
      const values = NAMES.map((name) => resourcesOf(name)[kind]);
      expect(new Set(values).size, kind).toBe(values.length);
    }
  });
});
