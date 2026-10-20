import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createClient } from '@1password/sdk';

const SCRIPT_DIRECTORY = import.meta.dirname;
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..', '..');

const ENVIRONMENT_NAMES = ['development', 'docker'] as const;

type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

// A variable gets its value from a 1Password reference, or is a fixed value that is not a secret
type VariableDefinition =
  | { variableName: string; reference: string }
  | { variableName: string; fixedValue: string };

interface EnvironmentFileDefinition {
  outputPath: string;
  variables: VariableDefinition[];
}

const REFERENCES = {
  supabaseURL: 'op://Audio Underview/Supabase/URL',
  supabaseSecretKey: 'op://Audio Underview/Supabase/secret key',
  googleClientID: 'op://Audio Underview/Google OAuth/client ID',
  googleClientSecret: 'op://Audio Underview/Google OAuth/client secret',
  githubClientID: 'op://Audio Underview/GitHub OAuth/client ID',
  githubClientSecret: 'op://Audio Underview/GitHub OAuth/client secret',
  axiomAPIToken: 'op://Audio Underview/Axiom/API token',
  codeRunnerFunctionURL: 'op://Audio Underview/Crawler Code Runner Function/URL',
};

function secretVariable(variableName: string, reference: string): VariableDefinition {
  return { variableName, reference };
}

function fixedVariable(variableName: string, fixedValue: string): VariableDefinition {
  return { variableName, fixedValue };
}

function createWorkerFile(workerName: string, variables: VariableDefinition[]): EnvironmentFileDefinition {
  return {
    outputPath: join(PROJECT_ROOT, 'workers', workerName, '.dev.vars.development'),
    variables,
  };
}

// The keys of each worker come from its Environment interface and the secrets listed in its wrangler.toml.
// `wrangler dev --env development` reads only .dev.vars.development once it exists.
function defineDevelopmentFiles(): EnvironmentFileDefinition[] {
  const item = 'op://Audio Underview/Development Environment';
  const jwtSecret = secretVariable('JWT_SECRET', `${item}/JWT secret`);
  const vaultInternalToken = secretVariable('VAULT_INTERNAL_TOKEN', `${item}/vault internal token`);
  const providerKeyKEK = secretVariable('PROVIDER_KEY_KEK', `${item}/provider key KEK`);
  const supabaseURL = secretVariable('SUPABASE_URL', REFERENCES.supabaseURL);
  const supabaseSecretKey = secretVariable('SUPABASE_SECRET_KEY', REFERENCES.supabaseSecretKey);
  const axiomAPIToken = secretVariable('AXIOM_API_TOKEN', REFERENCES.axiomAPIToken);
  const frontendURL = fixedVariable('FRONTEND_URL', 'https://localhost:5173');

  return [
    createWorkerFile('crawler-manager-worker', [
      supabaseURL,
      supabaseSecretKey,
      jwtSecret,
      secretVariable('CODE_RUNNER_FUNCTION_URL', REFERENCES.codeRunnerFunctionURL),
      vaultInternalToken,
    ]),
    createWorkerFile('scheduler-manager-worker', [supabaseURL, supabaseSecretKey, jwtSecret]),
    createWorkerFile('user-vault-worker', [providerKeyKEK, vaultInternalToken]),
    createWorkerFile('google-oauth-provider-worker', [
      secretVariable('GOOGLE_CLIENT_ID', REFERENCES.googleClientID),
      secretVariable('GOOGLE_CLIENT_SECRET', REFERENCES.googleClientSecret),
      frontendURL,
      supabaseURL,
      supabaseSecretKey,
      axiomAPIToken,
      jwtSecret,
    ]),
    createWorkerFile('github-oauth-provider-worker', [
      secretVariable('GITHUB_CLIENT_ID', REFERENCES.githubClientID),
      secretVariable('GITHUB_CLIENT_SECRET', REFERENCES.githubClientSecret),
      frontendURL,
      supabaseURL,
      supabaseSecretKey,
      axiomAPIToken,
      jwtSecret,
    ]),
    {
      outputPath: join(PROJECT_ROOT, 'applications', 'web', '.env.development.local'),
      variables: [secretVariable('VITE_GOOGLE_CLIENT_ID', REFERENCES.googleClientID)],
    },
  ];
}

// docker compose reads this file as --env-file and hands each service only the values it lists
// (docker/compose.yaml). It derives the rest (the web's client ID, the service role key), and it
// gives the workers no Axiom token, so the docker environment sends Axiom nothing.
function defineDockerFiles(): EnvironmentFileDefinition[] {
  const item = 'op://Audio Underview/Docker Environment';

  return [
    {
      outputPath: join(PROJECT_ROOT, 'docker', '.env.docker'),
      variables: [
        secretVariable('GOOGLE_CLIENT_ID', REFERENCES.googleClientID),
        secretVariable('GOOGLE_CLIENT_SECRET', REFERENCES.googleClientSecret),
        secretVariable('GITHUB_CLIENT_ID', REFERENCES.githubClientID),
        secretVariable('GITHUB_CLIENT_SECRET', REFERENCES.githubClientSecret),
        secretVariable('CODE_RUNNER_FUNCTION_URL', REFERENCES.codeRunnerFunctionURL),
        secretVariable('JWT_SECRET', `${item}/JWT secret`),
        secretVariable('VAULT_INTERNAL_TOKEN', `${item}/vault internal token`),
        secretVariable('PROVIDER_KEY_KEK', `${item}/provider key KEK`),
        secretVariable('POSTGREST_JWT_SECRET', `${item}/PostgREST JWT secret`),
      ],
    },
  ];
}

const USAGE =
  'Usage: OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate [development|docker]';

function readEnvironmentNames(): EnvironmentName[] {
  const commandLineArguments = process.argv.slice(2);

  if (commandLineArguments.length === 0) {
    return [...ENVIRONMENT_NAMES];
  }

  const [environmentName, ...rest] = commandLineArguments;
  const isKnown = ENVIRONMENT_NAMES.some((knownName) => knownName === environmentName);

  if (!isKnown || rest.length > 0) {
    console.error(`Error: expected one environment, either ${ENVIRONMENT_NAMES.join(' or ')}.\n${USAGE}`);
    process.exit(1);
  }

  return [environmentName as EnvironmentName];
}

function readToken(): string {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim() ?? '';

  if (!token) {
    console.error(`Error: OP_SERVICE_ACCOUNT_TOKEN environment variable is not set.\n${USAGE}`);
    process.exit(1);
  }

  return token;
}

function isValidSecretValue(value: string): boolean {
  if (!value) return false;
  if (value === 'REPLACE_ME') return false;
  return true;
}

// Single quotes keep the value literal for dotenv, Vite and Compose (a `$` is not expanded in them).
// Returns null for a value that no quoting holds safely, such as one with a newline.
function formatValue(value: string): string | null {
  if (/[\r\n]/.test(value)) return null;
  if (!value.includes("'")) return `'${value}'`;
  if (!/["$\\]/.test(value)) return `"${value}"`;
  return null;
}

function collectReferences(environmentFiles: EnvironmentFileDefinition[]): string[] {
  const references = new Set<string>();

  for (const environmentFile of environmentFiles) {
    for (const variable of environmentFile.variables) {
      if ('reference' in variable) {
        references.add(variable.reference);
      }
    }
  }

  return [...references];
}

async function generate(): Promise<void> {
  const environmentNames = readEnvironmentNames();
  const token = readToken();

  const environmentFiles = environmentNames.flatMap((environmentName) =>
    environmentName === 'development' ? defineDevelopmentFiles() : defineDockerFiles(),
  );

  console.log('Connecting to 1Password...');

  let client;
  try {
    client = await createClient({
      auth: token,
      integrationName: 'audio-underview',
      integrationVersion: '1.0.0',
    });
  } catch (error) {
    console.error(
      'Error: Failed to connect to 1Password.\n' +
        'Please verify your service account token is valid and has the required permissions.\n' +
        `Details: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  console.log('Resolving secrets...');

  const references = collectReferences(environmentFiles);
  const resolveAllResponse = await client.secrets.resolveAll(references);

  const resolvedSecrets = new Map<string, string>();

  for (const reference of references) {
    const response = resolveAllResponse.individualResponses[reference];

    if (response?.error) {
      console.warn(`  Skipping ${reference}: failed to resolve (${response.error.type})`);
      continue;
    }

    const secretValue = response?.content?.secret ?? '';

    if (!isValidSecretValue(secretValue)) {
      console.warn(`  Skipping ${reference}: empty or placeholder value`);
      continue;
    }

    resolvedSecrets.set(reference, secretValue);
    console.log(`  Resolved ${reference}`);
  }

  if (resolvedSecrets.size === 0) {
    console.warn('\nNo secrets were resolved. No environment files will be generated.');
    return;
  }

  for (const environmentFile of environmentFiles) {
    const lines: string[] = [];
    const writtenNames: string[] = [];
    const missingNames: string[] = [];
    const unsafeNames: string[] = [];

    for (const variable of environmentFile.variables) {
      const value = 'reference' in variable ? resolvedSecrets.get(variable.reference) : variable.fixedValue;

      if (value === undefined) {
        missingNames.push(variable.variableName);
        continue;
      }

      const formattedValue = formatValue(value);

      if (formattedValue === null) {
        unsafeNames.push(variable.variableName);
        continue;
      }

      lines.push(`${variable.variableName}=${formattedValue}`);
      writtenNames.push(variable.variableName);
    }

    if (lines.length === 0) {
      console.log(`\nSkipping ${environmentFile.outputPath}: no variables to write`);
      continue;
    }

    const outputDirectory = dirname(environmentFile.outputPath);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(environmentFile.outputPath, lines.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
    // The mode of writeFile applies only when the file is created
    await chmod(environmentFile.outputPath, 0o600);

    console.log(`\nGenerated ${environmentFile.outputPath}`);
    console.log(`  Variables set: ${writtenNames.join(', ')}`);
    if (missingNames.length > 0) {
      console.warn(`  Variables missing: ${missingNames.join(', ')}`);
    }
    if (unsafeNames.length > 0) {
      console.warn(`  Variables skipped, their values have characters an environment file cannot hold safely: ${unsafeNames.join(', ')}`);
    }
  }
}

await generate();
