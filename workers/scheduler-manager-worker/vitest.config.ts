import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: 'https://example.com',
          SUPABASE_URL: 'https://supabase.example.com',
          SUPABASE_SCHEMA: 'test_schema',
          SUPABASE_SECRET_KEY: 'test-secret-key',
          JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
        },
        workers: [
          {
            name: 'audio-underview-crawler-manager-worker',
            modules: true,
            script: 'export default { async fetch() { return Response.json({ success: true, result: null }); } }',
          },
        ],
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
