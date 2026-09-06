/**
 * 1Password vault(`Audio Underview`)에서 secret을 resolve해 로컬 .env 파일들을 생성한다.
 *
 * 생성 대상:
 *   - applications/web/.env  (Vite 빌드타임 키)
 *   - <root>/.env.workers    (authentication-worker secret 주입용 — 자동 로딩 없음)
 *   - <root>/.env.deploy     (GitHub secrets/vars 등록용 배포 자격증명 — 자동 로딩 없음)
 *
 * Usage:
 *   OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createClient } from '@1password/sdk';

import { SECRET_MAPPINGS, ENVIRONMENT_FILES } from './environment-definitions.ts';
import { isValidSecretValue, buildEnvironmentFileContent } from './formatters.ts';

const SCRIPT_DIRECTORY = import.meta.dirname;
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, '..', '..', '..');

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
    const outputPath = join(PROJECT_ROOT, ...environmentFile.outputPathSegments);
    const content = buildEnvironmentFileContent(environmentFile.variableNames, resolvedVariables);

    if (content === undefined) {
      console.log(`\nSkipping ${outputPath}: no variables to write`);
      continue;
    }

    const outputDirectory = dirname(outputPath);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(outputPath, content, 'utf-8');

    const writtenNames = environmentFile.variableNames.filter((variableName) => resolvedVariables.has(variableName));
    console.log(`\nGenerated ${outputPath}`);
    console.log(`  Variables set: ${writtenNames.join(', ')}`);
  }
}

await generate();
