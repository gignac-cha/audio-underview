import { describe, it, expect } from 'vitest';
import configurationText from '../wrangler.toml?raw';

// What each environment of wrangler.toml has to say. wrangler does not inherit vars or bindings into an
// [env.*] block, so a block that forgets one runs without it, and a binding that still names a resource of
// production sends the data of staging or development there. A missing SUPABASE_SCHEMA is the worst of
// these: the client then reaches `public`, the tables of production.
// The names follow documents/2026-10-19-staging-environment.md. The ids of KV namespaces are not asserted,
// because they are filled in when the resource is created; only that each environment has one of its own.

interface WorkerConfiguration {
  name?: string;
  vars?: Record<string, string>;
  services?: Array<{ binding: string; service: string; entrypoint?: string }>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  kv_namespaces?: Array<{ binding: string; id: string }>;
  workflows?: Array<{ binding: string; name: string; class_name: string }>;
  limits?: { cpu_ms?: number };
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

interface Expected {
  name: string;
  schema: string;
  origins: string;
  vault: string;
  crawlerManager: string;
  schedulerManager: string;
  bucket: string;
  workflow: string;
}

const EXPECTED: Record<EnvironmentName, Expected> = {
  production: {
    name: 'audio-underview-newscast-worker',
    schema: 'public',
    origins: 'https://audio-underview.pages.dev',
    vault: 'audio-underview-user-vault-worker',
    crawlerManager: 'audio-underview-crawler-manager-worker',
    schedulerManager: 'audio-underview-scheduler-manager-worker',
    bucket: 'audio-underview-newscast-audio',
    workflow: 'audio-underview-newscast-workflow',
  },
  staging: {
    name: 'audio-underview-newscast-staging-worker',
    schema: 'staging',
    origins: 'https://staging.audio-underview.pages.dev',
    vault: 'audio-underview-user-vault-staging-worker',
    crawlerManager: 'audio-underview-crawler-manager-staging-worker',
    schedulerManager: 'audio-underview-scheduler-manager-staging-worker',
    bucket: 'audio-underview-newscast-audio-staging',
    workflow: 'audio-underview-newscast-staging-workflow',
  },
  development: {
    name: 'audio-underview-newscast-development-worker',
    schema: 'development',
    origins: 'https://development.audio-underview.pages.dev,https://localhost:5173',
    vault: 'audio-underview-user-vault-development-worker',
    crawlerManager: 'audio-underview-crawler-manager-development-worker',
    schedulerManager: 'audio-underview-scheduler-manager-development-worker',
    bucket: 'audio-underview-newscast-audio-development',
    workflow: 'audio-underview-newscast-development-workflow',
  },
  docker: {
    name: 'audio-underview-newscast-docker-worker',
    schema: 'public',
    origins: 'https://localhost:5174',
    vault: 'audio-underview-user-vault-docker-worker',
    crawlerManager: 'audio-underview-crawler-manager-docker-worker',
    schedulerManager: 'audio-underview-scheduler-manager-docker-worker',
    bucket: 'audio-underview-newscast-audio-docker',
    workflow: 'audio-underview-newscast-docker-workflow',
  },
};

// The resources an environment must not share with production (or with another environment)
function resourcesOf(name: EnvironmentName): Record<string, string | undefined> {
  const worker = configurationOf(name);
  return {
    'worker name': worker.name,
    'vault worker': bindingOf(worker.services, 'USER_VAULT')?.service,
    'crawler manager worker': bindingOf(worker.services, 'CRAWLER_MANAGER')?.service,
    'scheduler manager worker': bindingOf(worker.services, 'SCHEDULER_TASK_GROUP_REPORTS')?.service,
    'scheduler manager API worker': bindingOf(worker.services, 'SCHEDULER_MANAGER')?.service,
    'audio bucket': bindingOf(worker.r2_buckets, 'NEWSCAST_AUDIO')?.bucket_name,
    'state namespace id': bindingOf(worker.kv_namespaces, 'NEWSCAST_STATE')?.id,
    'workflow name': bindingOf(worker.workflows, 'NEWSCAST_WORKFLOW')?.name,
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

    it('calls the vault, the crawler manager and the scheduler manager of its own environment', () => {
      const services = configurationOf(name).services;
      expect(services?.map((service) => service.binding).sort()).toEqual([
        'CRAWLER_MANAGER',
        'SCHEDULER_MANAGER',
        'SCHEDULER_TASK_GROUP_REPORTS',
        'USER_VAULT',
      ]);
      expect(bindingOf(services, 'USER_VAULT')?.service).toBe(expected.vault);
      expect(bindingOf(services, 'CRAWLER_MANAGER')?.service).toBe(expected.crawlerManager);
      expect(bindingOf(services, 'SCHEDULER_TASK_GROUP_REPORTS')?.service).toBe(expected.schedulerManager);
      expect(bindingOf(services, 'SCHEDULER_MANAGER')?.service).toBe(expected.schedulerManager);
    });

    it('reports to the TaskGroupReports entrypoint, and binds the other workers by their default', () => {
      const services = configurationOf(name).services;
      expect(bindingOf(services, 'SCHEDULER_TASK_GROUP_REPORTS')?.entrypoint).toBe('TaskGroupReports');
      expect(bindingOf(services, 'USER_VAULT')?.entrypoint).toBeUndefined();
      expect(bindingOf(services, 'CRAWLER_MANAGER')?.entrypoint).toBeUndefined();
      // The public API of the scheduler, which the newscast templates call with the Authorization of the caller
      expect(bindingOf(services, 'SCHEDULER_MANAGER')?.entrypoint).toBeUndefined();
    });

    it('keeps the audio in the bucket of its own', () => {
      const buckets = configurationOf(name).r2_buckets;
      expect(buckets).toHaveLength(1);
      expect(bindingOf(buckets, 'NEWSCAST_AUDIO')?.bucket_name).toBe(expected.bucket);
    });

    it('has the namespace of the newscast state, with an id', () => {
      const namespaces = configurationOf(name).kv_namespaces;
      expect(namespaces).toHaveLength(1);
      expect(bindingOf(namespaces, 'NEWSCAST_STATE')?.id).toBeTypeOf('string');
      expect(bindingOf(namespaces, 'NEWSCAST_STATE')?.id).not.toBe('');
    });

    it('makes newscasts in the workflow of its own environment, with the same class', () => {
      const workflows = configurationOf(name).workflows;
      expect(workflows).toHaveLength(1);
      expect(bindingOf(workflows, 'NEWSCAST_WORKFLOW')?.name).toBe(expected.workflow);
      expect(bindingOf(workflows, 'NEWSCAST_WORKFLOW')?.class_name).toBe('NewscastWorkflow');
    });

    it('raises the CPU limit to 5 minutes, which is inherited', () => {
      expect(configurationOf(name).limits?.cpu_ms ?? configuration.limits?.cpu_ms).toBe(300000);
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

  it('gives every environment a worker, the workers it calls, a bucket, a namespace and a workflow of its own', () => {
    for (const kind of Object.keys(resourcesOf('production'))) {
      const values = NAMES.map((name) => resourcesOf(name)[kind]);
      expect(new Set(values).size, kind).toBe(values.length);
    }
  });
});
