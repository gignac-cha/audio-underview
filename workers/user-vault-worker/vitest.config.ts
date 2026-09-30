import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Tests run inside workerd like the other workers, but they import the
// modules directly and pass a fake D1 object and a stubbed global fetch,
// so no miniflare bindings are declared here.
export default defineWorkersConfig({
  test: {
    include: ['sources/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
