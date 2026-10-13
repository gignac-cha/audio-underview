import type { Logger } from '@audio-underview/logger';
import { createSupabaseClient, type SupabaseClient } from '@audio-underview/supabase-connector';
import { HTTPCodeRunnerClient } from './code-runner-client.ts';
import type { CrawlerRuntimeDependencies } from './crawler-runtime/run-crawler.ts';
import { UserVaultClient } from './user-vault-client.ts';

export interface Environment {
  ALLOWED_ORIGINS: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  JWT_SECRET: string;
  /** Web crawlers still fetch their page through the code runner Lambda */
  CODE_RUNNER_FUNCTION_URL: string;
  /** Optional; the vault's value, sent in the x-user-vault-token header */
  VAULT_INTERNAL_TOKEN?: string;
  LOADER: WorkerLoader;
  CRAWLER_FILES: R2Bucket;
  USER_VAULT: Fetcher;
}

export function createSupabaseClientFrom(environment: Environment): SupabaseClient {
  return createSupabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });
}

export function createUserVaultClient(environment: Environment): UserVaultClient {
  return new UserVaultClient(environment.USER_VAULT, environment.VAULT_INTERNAL_TOKEN);
}

export function createCrawlerRuntimeDependencies(
  environment: Environment,
  logger: Logger,
  supabaseClient: SupabaseClient = createSupabaseClientFrom(environment),
): CrawlerRuntimeDependencies {
  return {
    supabaseClient,
    loader: environment.LOADER,
    bucket: environment.CRAWLER_FILES,
    userVaultClient: createUserVaultClient(environment),
    codeRunnerClient: new HTTPCodeRunnerClient(environment.CODE_RUNNER_FUNCTION_URL),
    logger,
  };
}
