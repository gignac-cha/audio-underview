import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            GITHUB_CLIENT_ID: 'test-github-client-id',
            GITHUB_CLIENT_SECRET: 'test-github-client-secret',
            FRONTEND_URL: 'https://example.com',
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_SECRET_KEY: 'test-supabase-secret',
            AXIOM_API_TOKEN: 'test-axiom-token',
            AXIOM_DATASET: 'test-dataset',
            ALLOWED_ORIGINS: 'https://example.com',
          },
        },
      },
    },
  },
});
