import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ALLOWED_ORIGINS: 'https://example.com',
          },
          unsafeEvalBinding: 'UNSAFE_EVAL',
        },
      },
    },
  },
});
