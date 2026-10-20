import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd like the other workers, but they import the
// modules directly and pass a fake D1 object and a stubbed global fetch,
// so no miniflare bindings are declared here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  test: {
    // tests/ holds the checks of wrangler.toml, which need ?raw and so stay out of the typechecked sources
    include: ['sources/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // The Workers runtime cannot read the module cache Vitest writes to disk
    fsModuleCache: false,
  },
});
