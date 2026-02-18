import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createClient } from '@1password/sdk';

const SCRIPT_DIRECTORY = import.meta.dirname;
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..', '..');

interface SecretMapping {
  reference: string;
  variableName: string;
}

const SECRET_MAPPINGS: SecretMapping[] = [
  {
    reference: 'op://Audio Underview/Google OAuth/client ID',
    variableName: 'VITE_GOOGLE_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/GitHub OAuth Worker/URL',
    variableName: 'VITE_GITHUB_OAUTH_WORKER_URL',
  },
  {
    reference: 'op://Audio Underview/Crawler Code Runner/URL',
    variableName: 'VITE_CRAWLER_CODE_RUNNER_URL',
  },
  {
    reference: 'op://Audio Underview/Crawler Manager Worker/URL',
    variableName: 'VITE_CRAWLER_MANAGER_WORKER_URL',
  },
  {
    reference: 'op://Audio Underview/GitHub OAuth/client ID',
    variableName: 'OAUTH_GITHUB_CLIENT_ID',
  },
  {
    reference: 'op://Audio Underview/GitHub OAuth/client secret',
    variableName: 'OAUTH_GITHUB_CLIENT_SECRET',
  },
  {
    reference: 'op://Audio Underview/Cloudflare/API token',
    variableName: 'CLOUDFLARE_API_TOKEN',
  },
  {
    reference: 'op://Audio Underview/Cloudflare/account ID',
    variableName: 'CLOUDFLARE_ACCOUNT_ID',
  },
  {
    reference: 'op://Audio Underview/AWS/access key ID',
    variableName: 'AWS_ACCESS_KEY_ID',
  },
  {
    reference: 'op://Audio Underview/AWS/secret access key',
    variableName: 'AWS_SECRET_ACCESS_KEY',
  },
  {
    reference: 'op://Audio Underview/AWS/Lambda execution role ARN',
    variableName: 'AWS_LAMBDA_EXECUTION_ROLE_ARN',
  },
  {
    reference: 'op://Audio Underview/AWS/region',
    variableName: 'AWS_REGION',
  },
  {
    reference: 'op://Audio Underview/Frontend/URL',
    variableName: 'FRONTEND_URL',
  },
  {
    reference: 'op://Audio Underview/Frontend/allowed origins',
    variableName: 'ALLOWED_ORIGINS',
  },
];

interface EnvironmentFileDefinition {
  outputPath: string;
  variableNames: string[];
}

const ENVIRONMENT_FILES: EnvironmentFileDefinition[] = [
  {
    outputPath: join(PROJECT_ROOT, 'applications', 'web', '.env'),
    variableNames: [
      'VITE_GOOGLE_CLIENT_ID',
      'VITE_GITHUB_OAUTH_WORKER_URL',
      'VITE_CRAWLER_CODE_RUNNER_URL',
      'VITE_CRAWLER_MANAGER_WORKER_URL',
    ],
  },
  {
    outputPath: join(PROJECT_ROOT, '.env.workers'),
    variableNames: [
      'OAUTH_GITHUB_CLIENT_ID',
      'OAUTH_GITHUB_CLIENT_SECRET',
      'FRONTEND_URL',
      'ALLOWED_ORIGINS',
    ],
  },
  {
    outputPath: join(PROJECT_ROOT, '.env.deploy'),
    variableNames: [
      'CLOUDFLARE_API_TOKEN',
      'CLOUDFLARE_ACCOUNT_ID',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_LAMBDA_EXECUTION_ROLE_ARN',
      'AWS_REGION',
    ],
  },
];

function readToken(): string {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim() ?? '';

  if (!token) {
    console.error(
      'Error: OP_SERVICE_ACCOUNT_TOKEN environment variable is not set.\n' +
        'Usage: OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate',
    );
    process.exit(1);
  }

  return token;
}

function isValidSecretValue(value: string): boolean {
  if (!value) return false;
  if (value === 'REPLACE_ME') return false;
  return true;
}

async function generate(): Promise<void> {
  const token = readToken();

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

  const references = SECRET_MAPPINGS.map((mapping) => mapping.reference);
  const resolveAllResponse = await client.secrets.resolveAll(references);

  const resolvedVariables = new Map<string, string>();

  for (const mapping of SECRET_MAPPINGS) {
    const response = resolveAllResponse.individualResponses[mapping.reference];

    if (response?.error) {
      console.warn(`  Skipping ${mapping.variableName}: failed to resolve (${response.error.type})`);
      continue;
    }

    const secretValue = response?.content?.secret ?? '';

    if (!isValidSecretValue(secretValue)) {
      console.warn(`  Skipping ${mapping.variableName}: empty or placeholder value`);
      continue;
    }

    resolvedVariables.set(mapping.variableName, secretValue);
    console.log(`  Resolved ${mapping.variableName}`);
  }

  if (resolvedVariables.size === 0) {
    console.warn('\nNo secrets were resolved. No .env files will be generated.');
    return;
  }

  for (const environmentFile of ENVIRONMENT_FILES) {
    const lines: string[] = [];

    for (const variableName of environmentFile.variableNames) {
      const value = resolvedVariables.get(variableName);
      if (value !== undefined) {
        lines.push(`${variableName}="${value}"`);
      }
    }

    if (lines.length === 0) {
      console.log(`\nSkipping ${environmentFile.outputPath}: no variables to write`);
      continue;
    }

    const outputDirectory = dirname(environmentFile.outputPath);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(environmentFile.outputPath, lines.join('\n') + '\n', 'utf-8');

    console.log(`\nGenerated ${environmentFile.outputPath}`);
    console.log(`  Variables set: ${lines.map((line) => line.split('=')[0]).join(', ')}`);
  }
}

await generate();
