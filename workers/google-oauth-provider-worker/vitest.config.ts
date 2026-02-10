import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            GOOGLE_CLIENT_ID: 'test-google-client-id',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
            FRONTEND_URL: 'https://example.com',
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_SECRET_KEY: 'test-supabase-secret',
            AXIOM_API_TOKEN: 'test-axiom-token',
            AXIOM_DATASET: 'test-dataset',
          },
        },
      },
    },
  },
});
