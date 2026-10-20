/**
 * The environments this tool builds, each in the schema of the same name.
 * Production (`public`) is never one of them: the tool only reads it.
 */
export const ENVIRONMENTS = ['staging', 'development'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export interface BuildArguments {
  environment: Environment;
  /** Development only: drop the schema and rebuild it from the first migration. Staging is rebuilt on every run. */
  reset: boolean;
}

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** Throws unless `schema` is one of {@link ENVIRONMENTS}, so no SQL this tool builds can write to another schema. */
export function assertEnvironmentSchema(schema: string): asserts schema is Environment {
  if (!isEnvironment(schema)) {
    throw new Error(`refusing to write to schema ${JSON.stringify(schema)}: only ${ENVIRONMENTS.join(' and ')} are allowed`);
  }
}

/** Reads `<staging|development> [--reset]`. */
export function parseBuildArguments(arguments_: string[]): BuildArguments {
  const usage = `usage: build-environment-schema.ts <${ENVIRONMENTS.join('|')}> [--reset]`;
  const flags = arguments_.filter((argument) => argument.startsWith('-'));
  const positionals = arguments_.filter((argument) => !argument.startsWith('-'));

  const unknownFlags = flags.filter((flag) => flag !== '--reset');
  if (unknownFlags.length > 0) {
    throw new Error(`unknown option ${unknownFlags.join(', ')}\n${usage}`);
  }
  if (positionals.length !== 1) {
    throw new Error(usage);
  }

  const [environment] = positionals;
  assertEnvironmentSchema(environment);
  return { environment, reset: flags.includes('--reset') };
}
