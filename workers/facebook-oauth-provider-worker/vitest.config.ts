import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            FACEBOOK_CLIENT_ID: 'test-facebook-client-id',
            FACEBOOK_CLIENT_SECRET: 'test-facebook-client-secret',
            FRONTEND_URL: 'https://example.com',
          },
        },
      },
    },
  },
});
