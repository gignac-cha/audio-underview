// Starts the six environment workers of the docker environment in one container.
//
// wrangler dev lists every running worker in its local dev registry, a directory with one file per
// worker that records the address of a debug port the worker's workerd binds on 127.0.0.1. A service
// binding to a worker that another wrangler dev process runs goes through that address. Containers
// do not share 127.0.0.1, so the workers run as processes of this one container instead of one
// container each.
//
// Before starting them this writes each worker's .dev.vars.docker from the variables compose passes
// from docker/.env.docker (so no secret is in the image).

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const WORKSPACE_DIRECTORY = resolve(import.meta.dirname, '..', '..');
const WRANGLER = join(WORKSPACE_DIRECTORY, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

// The worker-state volume; each worker keeps its local R2, KV and Workflow data in its own directory
const STATE_DIRECTORY = '/worker-state';

// A fresh registry on every start, so entries a killed process left behind do not block registration
const REGISTRY_DIRECTORY = '/tmp/wrangler-registry';

// The login workers always export their traces to Axiom. This environment sends Axiom nothing: they
// get this token, which Axiom rejects, and compose points api.axiom.co back at this container.
const AXIOM_API_TOKEN_PLACEHOLDER = 'docker-environment-sends-no-traces';

// The keys of docker/.env.docker that compose passes to this container. The wrangler processes do not
// get them in their environment; each worker gets the ones it uses through its .dev.vars.docker.
const SECRET_NAMES = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'CODE_RUNNER_FUNCTION_URL',
  'JWT_SECRET',
  'VAULT_INTERNAL_TOKEN',
  'PROVIDER_KEY_KEK',
  'POSTGREST_JWT_SECRET',
];

interface DockerWorker {
  label: string;
  directory: string;
  port: number;
  inspectorPort: number;
  // Written to .dev.vars.docker; a variable without a value is left out
  variables: Record<string, string | undefined>;
}

// Values are used as compose passes them, so the service role key is signed with exactly the secret rest uses
function readVariable(name: string): string | undefined {
  const value = process.env[name];
  return value === '' ? undefined : value;
}

function requireVariable(name: string, hint: string): string {
  const value = readVariable(name);
  if (value === undefined) {
    console.error(`Error: ${name} is not set. ${hint}`);
    process.exit(1);
  }
  return value;
}

// The workers reach PostgREST with supabase-js, which sends the secret key as a Bearer token.
// PostgREST accepts a JWT signed with its secret and runs the request as the role the JWT names.
function createServiceRoleKey(jwtSecret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: 'audio-underview-docker', role: 'service_role', iat: Math.floor(Date.now() / 1000) });
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

// Single quotes keep the value literal for dotenv, which wrangler reads .dev.vars with
function formatValue(name: string, value: string): string {
  if (!/[\r\n]/.test(value)) {
    if (!value.includes("'")) return `'${value}'`;
    if (!/["\\]/.test(value)) return `"${value}"`;
  }
  console.error(`Error: the value of ${name} has characters .dev.vars.docker cannot hold as written here`);
  process.exit(1);
}

function writeDevelopmentVariables(worker: DockerWorker): void {
  const lines: string[] = [];
  const missingNames: string[] = [];

  for (const [name, value] of Object.entries(worker.variables)) {
    if (value === undefined) {
      missingNames.push(name);
    } else {
      lines.push(`${name}=${formatValue(name, value)}`);
    }
  }

  if (missingNames.length > 0) {
    console.warn(`[${worker.label}] Not set in docker/.env.docker, so left out of .dev.vars.docker: ${missingNames.join(', ')}`);
  }

  const path = join(WORKSPACE_DIRECTORY, 'workers', worker.directory, '.dev.vars.docker');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

function createChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, WRANGLER_REGISTRY_PATH: REGISTRY_DIRECTORY };
  for (const name of SECRET_NAMES) {
    delete environment[name];
  }
  return environment;
}

// Prefixes every output line with the worker's label, since six processes share one log
function forwardOutput(label: string, child: ChildProcess): void {
  for (const [stream, output] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ] as const) {
    if (stream === null) continue;
    createInterface({ input: stream }).on('line', (line) => output.write(`[${label}] ${line}\n`));
  }
}

function runWrangler(worker: DockerWorker, commandArguments: string[]): ChildProcess {
  const child = spawn(process.execPath, [WRANGLER, ...commandArguments], {
    cwd: join(WORKSPACE_DIRECTORY, 'workers', worker.directory),
    env: createChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  forwardOutput(worker.label, child);
  return child;
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolveExit) => {
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

function stateDirectory(worker: DockerWorker): string {
  return join(STATE_DIRECTORY, worker.directory);
}

function startWorker(worker: DockerWorker): ChildProcess {
  return runWrangler(worker, [
    'dev',
    '--env',
    'docker',
    '--ip',
    '0.0.0.0',
    '--port',
    String(worker.port),
    '--inspector-port',
    String(worker.inspectorPort),
    '--persist-to',
    stateDirectory(worker),
    '--show-interactive-dev-session=false',
  ]);
}

async function main(): Promise<void> {
  const supabaseURL = requireVariable('SUPABASE_URL', 'docker/compose.yaml sets it to the gateway service.');
  const frontendURL = requireVariable('FRONTEND_URL', 'docker/compose.yaml sets it to the web address.');
  const postgrestJWTSecret = requireVariable('POSTGREST_JWT_SECRET', 'Generate docker/.env.docker (docker/README.md).');
  if (postgrestJWTSecret.length < 32) {
    console.error('Error: POSTGREST_JWT_SECRET must be at least 32 characters long; PostgREST rejects a shorter secret.');
    process.exit(1);
  }

  const supabase = {
    SUPABASE_URL: supabaseURL,
    SUPABASE_SECRET_KEY: createServiceRoleKey(postgrestJWTSecret),
  };
  const jwtSecret = readVariable('JWT_SECRET');
  const vaultInternalToken = readVariable('VAULT_INTERNAL_TOKEN');

  // Ports and keys follow each worker's Environment interface and the secrets in its wrangler.toml
  const workers: DockerWorker[] = [
    {
      label: 'google',
      directory: 'google-oauth-provider-worker',
      port: 9787,
      inspectorPort: 9330,
      variables: {
        GOOGLE_CLIENT_ID: readVariable('GOOGLE_CLIENT_ID'),
        GOOGLE_CLIENT_SECRET: readVariable('GOOGLE_CLIENT_SECRET'),
        FRONTEND_URL: frontendURL,
        ...supabase,
        AXIOM_API_TOKEN: AXIOM_API_TOKEN_PLACEHOLDER,
        JWT_SECRET: jwtSecret,
      },
    },
    {
      label: 'github',
      directory: 'github-oauth-provider-worker',
      port: 9788,
      inspectorPort: 9331,
      variables: {
        GITHUB_CLIENT_ID: readVariable('GITHUB_CLIENT_ID'),
        GITHUB_CLIENT_SECRET: readVariable('GITHUB_CLIENT_SECRET'),
        FRONTEND_URL: frontendURL,
        ...supabase,
        AXIOM_API_TOKEN: AXIOM_API_TOKEN_PLACEHOLDER,
        JWT_SECRET: jwtSecret,
      },
    },
    {
      label: 'crawler-manager',
      directory: 'crawler-manager-worker',
      port: 9789,
      inspectorPort: 9332,
      variables: {
        ...supabase,
        JWT_SECRET: jwtSecret,
        CODE_RUNNER_FUNCTION_URL: readVariable('CODE_RUNNER_FUNCTION_URL'),
        VAULT_INTERNAL_TOKEN: vaultInternalToken,
      },
    },
    {
      label: 'scheduler-manager',
      directory: 'scheduler-manager-worker',
      port: 9790,
      inspectorPort: 9333,
      variables: {
        ...supabase,
        JWT_SECRET: jwtSecret,
      },
    },
    {
      label: 'user-vault',
      directory: 'user-vault-worker',
      port: 9791,
      inspectorPort: 9334,
      variables: {
        ...supabase,
        PROVIDER_KEY_KEK: readVariable('PROVIDER_KEY_KEK'),
        VAULT_INTERNAL_TOKEN: vaultInternalToken,
      },
    },
    {
      label: 'newscast',
      directory: 'newscast-worker',
      port: 9792,
      inspectorPort: 9335,
      variables: {
        ...supabase,
        JWT_SECRET: jwtSecret,
        VAULT_INTERNAL_TOKEN: vaultInternalToken,
      },
    },
  ];

  for (const worker of workers) {
    writeDevelopmentVariables(worker);
    mkdirSync(stateDirectory(worker), { recursive: true });
  }
  rmSync(REGISTRY_DIRECTORY, { recursive: true, force: true });

  const children = workers.map((worker) => ({ worker, child: startWorker(worker) }));
  let stopping = false;
  let exitCode = 0;

  const stopAll = (signal: NodeJS.Signals) => {
    stopping = true;
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  };
  process.on('SIGTERM', () => stopAll('SIGTERM'));
  process.on('SIGINT', () => stopAll('SIGINT'));

  // One worker stopping on its own takes the others down, so compose shows the service as exited
  const exits = children.map(({ worker, child }) =>
    waitForExit(child).then((code) => {
      if (!stopping) {
        console.error(`[${worker.label}] wrangler dev exited with code ${code}; stopping the other workers`);
        exitCode = code === 0 ? 1 : code;
        stopAll('SIGTERM');
      }
    }),
  );
  await Promise.all(exits);
  process.exit(exitCode);
}

await main();
