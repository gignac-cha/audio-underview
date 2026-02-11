import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
            MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
            MICROSOFT_TENANT: 'common',
            FRONTEND_URL: 'https://example.com',
            ALLOWED_ORIGINS: 'https://example.com',
            AXIOM_API_TOKEN: 'test-axiom-token',
            AXIOM_DATASET: 'test-dataset',
          },
        },
      },
    },
  },
});
