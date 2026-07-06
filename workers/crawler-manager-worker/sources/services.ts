import { issueAccessToken } from '@audio-underview/authentication-core';
import {
  createCrawlerWithOwnerPermission,
  createDatabaseClient,
  deleteCrawler,
  getCrawler,
  getCrawlerByID,
  listCrawlersByUser,
  updateCrawler,
  type CrawlerRow,
  type CrawlersUpdate,
  type CreateCrawlerInput,
  type ListOptions,
  type ListResult,
} from '@audio-underview/database-connector';
import { createHTTPCodeRunnerClient, type CodeRunnerClient } from './code-runner-client.ts';
import {
  parseCrawlerManagerEnvironment,
  type WorkerEnvironment,
} from './environment.ts';

/**
 * 핸들러/실행기가 사용하는 서비스 표면. 테스트는 fake로 대체한다.
 */
export interface CrawlerManagerServices {
  crawlers: {
    createWithOwnerPermission(input: CreateCrawlerInput): Promise<CrawlerRow>;
    list(userUUID: string, options: ListOptions): Promise<ListResult<CrawlerRow>>;
    get(id: string, userUUID: string): Promise<CrawlerRow | undefined>;
    getByID(id: string): Promise<CrawlerRow | undefined>;
    update(id: string, userUUID: string, input: CrawlersUpdate): Promise<CrawlerRow | undefined>;
    delete(id: string, userUUID: string): Promise<boolean>;
  };
  codeRunner: CodeRunnerClient;
  /** code-runner 호출용 service token (sub = crawler 소유자, 만료 1h) */
  createServiceToken(userUUID: string): Promise<string>;
}

export type ResolveServices = (environment: WorkerEnvironment) => CrawlerManagerServices;

export const createServices: ResolveServices = (rawEnvironment) => {
  const environment = parseCrawlerManagerEnvironment(rawEnvironment);
  const client = createDatabaseClient({
    supabaseURL: environment.SUPABASE_URL,
    supabaseSecretKey: environment.SUPABASE_SECRET_KEY,
  });

  return {
    crawlers: {
      createWithOwnerPermission: (input) => createCrawlerWithOwnerPermission(client, input),
      list: (userUUID, options) => listCrawlersByUser(client, userUUID, options),
      get: (id, userUUID) => getCrawler(client, id, userUUID),
      getByID: (id) => getCrawlerByID(client, id),
      update: (id, userUUID, input) => updateCrawler(client, id, userUUID, input),
      delete: (id, userUUID) => deleteCrawler(client, id, userUUID),
    },
    codeRunner: createHTTPCodeRunnerClient({ baseURL: environment.CODE_RUNNER_FUNCTION_URL }),
    createServiceToken: async (userUUID) => {
      const { token } = await issueAccessToken({ userUUID, secret: environment.JWT_SECRET });
      return token;
    },
  };
};
