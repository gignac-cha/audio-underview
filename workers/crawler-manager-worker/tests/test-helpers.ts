import { signJWT } from '@audio-underview/worker-foundation';
import { JWT_AUDIENCE, JWT_ISSUER } from '@audio-underview/schemas';
import type { CrawlerRow } from '@audio-underview/database-connector';
import type { CrawlerManagerServices } from '../sources/services.ts';
import type { WorkerEnvironment } from '../sources/environment.ts';

export const JWT_SECRET = 'test-jwt-secret';
export const USER_UUID = '00000000-0000-4000-8000-000000000009';
export const CRAWLER_ID = '00000000-0000-4000-8000-000000000001';

export const environment: WorkerEnvironment = {
  ALLOWED_ORIGINS: 'https://app.example.com',
  JWT_SECRET,
};

export const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

export const createBearerToken = (userUUID = USER_UUID): Promise<string> =>
  signJWT(
    {
      sub: userUUID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
    },
    JWT_SECRET,
  );

export const mockCrawler: CrawlerRow = {
  id: CRAWLER_ID,
  user_uuid: USER_UUID,
  name: 'Test Crawler',
  type: 'web',
  url_pattern: '.*\\.example\\.com',
  code: '(text) => ({ title: "test" })',
  input_schema: { body: 'string' },
  output_schema: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** 전 메서드가 "미구현 throw"인 기본 fake — 테스트가 필요한 것만 덮어쓴다. */
export const createFakeServices = (
  overrides: {
    crawlers?: Partial<CrawlerManagerServices['crawlers']>;
    codeRunner?: CrawlerManagerServices['codeRunner'];
  } = {},
): CrawlerManagerServices => {
  const unimplemented = (name: string) => () => {
    throw new Error(`fake not implemented: ${name}`);
  };
  return {
    crawlers: {
      createWithOwnerPermission: unimplemented('createWithOwnerPermission'),
      list: unimplemented('list'),
      get: unimplemented('get'),
      getByID: unimplemented('getByID'),
      update: unimplemented('update'),
      delete: unimplemented('delete'),
      ...overrides.crawlers,
    },
    codeRunner: overrides.codeRunner ?? {
      run: unimplemented('codeRunner.run'),
    },
    createServiceToken: () => Promise.resolve('service-token'),
  };
};
