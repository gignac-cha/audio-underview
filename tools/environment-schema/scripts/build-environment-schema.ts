import { fileURLToPath } from 'node:url';
import { buildEnvironmentSchema, formatSummary } from './environment-schema.ts';
import { parseBuildArguments } from './environments.ts';
import { createManagementDatabase } from './management-api.ts';
import { readMigrationFiles } from './migration-files.ts';

/**
 * Builds the staging or development schema of the Supabase project from
 * `packages/supabase-connector/migrations`, in one transaction.
 *
 *   node tools/environment-schema/scripts/build-environment-schema.ts <staging|development> [--reset]
 *
 * Environment:
 * - `SUPABASE_ACCESS_TOKEN`: Management API token.
 * - `SUPABASE_PROJECT_ID`: project ref.
 *
 * Production (`public`) is only read. Exits non-zero on any failure.
 */

const migrationsDirectory = fileURLToPath(new URL('../../../packages/supabase-connector/migrations', import.meta.url));

function requireEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** `message` with the given secrets masked, in case an error echoes one. */
function redact(message: string, secrets: (string | undefined)[]): string {
  return secrets.reduce<string>((text, secret) => (secret === undefined || secret === '' ? text : text.replaceAll(secret, '***')), message);
}

try {
  const { environment, reset } = parseBuildArguments(process.argv.slice(2));
  const database = createManagementDatabase({
    accessToken: requireEnvironmentVariable('SUPABASE_ACCESS_TOKEN'),
    projectId: requireEnvironmentVariable('SUPABASE_PROJECT_ID'),
  });
  const summary = await buildEnvironmentSchema({ environment, reset, files: readMigrationFiles(migrationsDirectory), database });
  for (const line of formatSummary(summary)) {
    console.log(line);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`build-environment-schema: ${redact(message, [process.env.SUPABASE_ACCESS_TOKEN, process.env.SUPABASE_PROJECT_ID])}`);
  process.exitCode = 1;
}
