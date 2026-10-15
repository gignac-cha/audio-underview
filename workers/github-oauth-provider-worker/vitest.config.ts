import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
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
          // `https://app.example.com` is the SPA origin these tests redirect
          // back to; `/authorize` and `/callback` now refuse any origin that
          // is not listed here, so it has to be trusted like the real SPA is.
          ALLOWED_ORIGINS: 'https://example.com,https://app.example.com',
          JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
        },
      },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['@audio-underview/worker-tools/tests/setup.ts'],
    // The Workers runtime cannot read the module cache Vitest writes to disk
    fsModuleCache: false,
  },
});
