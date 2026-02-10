import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            NAVER_CLIENT_ID: 'test-naver-client-id',
            NAVER_CLIENT_SECRET: 'test-naver-client-secret',
            FRONTEND_URL: 'https://example.com',
          },
        },
      },
    },
  },
});
