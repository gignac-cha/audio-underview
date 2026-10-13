import { vi } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import { createSupabaseClient, type CrawlerRow } from '@audio-underview/supabase-connector';
import type { Logger } from '@audio-underview/logger';
import { HTTPCodeRunnerClient } from '../sources/code-runner-client.ts';
import type { CrawlerRuntimeDependencies, CrawlerWorkerCode } from '../sources/crawler-runtime/run-crawler.ts';
import { UserVaultClient } from '../sources/user-vault-client.ts';
import type { Environment } from '../sources/environment.ts';
import type { InMemorySupabase } from './in-memory-supabase.ts';

export const testEnvironment = env as unknown as Environment;

export const SUPABASE_ORIGIN = 'https://supabase.example.com';
export const CODE_RUNNER_ORIGIN = 'https://code-runner.example.com';
export const VAULT_TOKEN = 'test-vault-token';

/** A UUID unique to the test, so Dynamic Workers and vault answers of tests never mix */
export function uniqueUUID(): string {
  return crypto.randomUUID();
}

export function crawlerRow(overrides: Partial<CrawlerRow> = {}): CrawlerRow {
  return {
    id: uniqueUUID(),
    user_uuid: uniqueUUID(),
    name: 'Test Crawler',
    type: 'data',
    url_pattern: null,
    code: '(input) => input',
    input_schema: {},
    output_schema: {},
    created_at: '2026-10-13T00:00:00Z',
    updated_at: '2026-10-13T00:00:00Z',
    ...overrides,
  };
}

export function addCrawler(supabase: InMemorySupabase, crawler: CrawlerRow): CrawlerRow {
  supabase.tables.crawlers ??= [];
  supabase.tables.crawlers.push({ ...crawler });
  return crawler;
}

export type MockLogger = Logger & {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

export function createMockLogger(): MockLogger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    createChild: vi.fn(),
  };
  logger.createChild.mockReturnValue(logger);
  return logger as unknown as MockLogger;
}

export interface LoaderCall {
  id: string;
  workerCode: CrawlerWorkerCode;
}

/**
 * The LOADER binding of the test worker, recording the ID and the code each get() loads.
 */
export function createRecordingLoader(): { loader: WorkerLoader; calls: LoaderCall[] } {
  const calls: LoaderCall[] = [];
  const loader: WorkerLoader = {
    get(id, getCode) {
      return testEnvironment.LOADER.get(id, async () => {
        const workerCode = await getCode();
        calls.push({ id: String(id), workerCode: workerCode as CrawlerWorkerCode });
        return workerCode;
      });
    },
  };
  return { loader, calls };
}

export function createTestDependencies(overrides: Partial<CrawlerRuntimeDependencies> = {}): CrawlerRuntimeDependencies & {
  logger: MockLogger;
} {
  return {
    supabaseClient: createSupabaseClient({ supabaseURL: SUPABASE_ORIGIN, supabaseSecretKey: 'test-secret-key' }),
    loader: testEnvironment.LOADER,
    bucket: testEnvironment.CRAWLER_FILES,
    userVaultClient: new UserVaultClient(testEnvironment.USER_VAULT, VAULT_TOKEN),
    codeRunnerClient: new HTTPCodeRunnerClient(CODE_RUNNER_ORIGIN),
    logger: createMockLogger(),
    ...overrides,
  } as CrawlerRuntimeDependencies & { logger: MockLogger };
}

export type VaultAnswer = { status: number | 'unreachable'; body?: unknown };

/**
 * Sets how the stand-in vault answers for one user.
 */
export async function configureVault(userUUID: string, responses: Record<string, VaultAnswer>): Promise<void> {
  const response = await testEnvironment.USER_VAULT.fetch('https://user-vault.internal/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ userId: userUUID, responses }),
  });
  await response.text();
}

export async function vaultEnvironment(userUUID: string, variables: Record<string, string>): Promise<void> {
  await configureVault(userUUID, { resolve: { status: 200, body: { variables } } });
}

export interface VaultRequest {
  userId: string;
  route: string;
  method: string;
  token: string | null;
  body: Record<string, unknown>;
}

export async function vaultRequests(userUUID: string): Promise<VaultRequest[]> {
  const response = await testEnvironment.USER_VAULT.fetch(
    `https://user-vault.internal/__test__/requests?userId=${encodeURIComponent(userUUID)}`,
  );
  return response.json();
}

export const WORKER_URL = 'https://worker.example.com';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';

export async function createTestJWT(subject: string): Promise<string> {
  const { signJWT } = await import('@audio-underview/worker-tools');
  const now = Math.floor(Date.now() / 1000);
  return signJWT({ sub: subject, iat: now, exp: now + 86400 }, JWT_SECRET);
}

/**
 * A request to the worker, authenticated as the user unless userUUID is null.
 */
export async function workerRequest(
  path: string,
  options: { method?: string; body?: string; userUUID?: string | null } = {},
): Promise<Request> {
  const headers = new Headers({ Origin: 'https://example.com' });
  if (options.userUUID !== null && options.userUUID !== undefined) {
    headers.set('Authorization', `Bearer ${await createTestJWT(options.userUUID)}`);
  }
  return new Request(`${WORKER_URL}${path}`, { method: options.method ?? 'GET', headers, body: options.body });
}

/**
 * The code runner Lambda answers the page body for one web crawler request, and records the request.
 */
export function mockPageBody(body: string): { requests: unknown[] } {
  const requests: unknown[] = [];
  fetchMock
    .get(CODE_RUNNER_ORIGIN)
    .intercept({ path: '/run', method: 'POST' })
    .reply((options) => {
      requests.push(JSON.parse(String(options.body)));
      return { statusCode: 200, data: JSON.stringify({ type: 'web', mode: 'run', result: body }) };
    });
  return { requests };
}
