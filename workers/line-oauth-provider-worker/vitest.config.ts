import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            LINE_CHANNEL_ID: 'test-line-channel-id',
            LINE_CHANNEL_SECRET: 'test-line-channel-secret',
            FRONTEND_URL: 'https://example.com',
            SUPABASE_URL: 'https://test.supabase.co',
            SUPABASE_SECRET_KEY: 'test-supabase-secret',
            AXIOM_API_TOKEN: 'test-axiom-token',
            AXIOM_DATASET: 'test-dataset',
            // `https://app.example.com` is the SPA origin these tests redirect
            // back to; `/authorize` and `/callback` now refuse any origin that
            // is not listed here, so it has to be trusted like the real SPA is.
            ALLOWED_ORIGINS: 'https://example.com,https://app.example.com',
            JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
          },
        },
      },
    },
  },
});
