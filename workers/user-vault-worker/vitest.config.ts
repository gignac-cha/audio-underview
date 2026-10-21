import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd like the other workers, but they import the
// modules directly, pass the environment themselves and stub the global
// fetch, which tests/in-memory-supabase.ts answers for Supabase, so no
// miniflare bindings are declared here.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  test: {
    // tests/ holds the checks that read files with ?raw and so stay out of the typechecked sources,
    // and the in-memory Supabase the tests of the sources import
    include: ['sources/**/*.test.ts', 'tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // The Workers runtime cannot read the module cache Vitest writes to disk
    fsModuleCache: false,
  },
});
