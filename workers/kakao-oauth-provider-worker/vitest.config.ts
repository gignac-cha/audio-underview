import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            KAKAO_CLIENT_ID: 'test-kakao-client-id',
            KAKAO_CLIENT_SECRET: 'test-kakao-client-secret',
            FRONTEND_URL: 'https://example.com',
          },
        },
      },
    },
  },
});
