import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// The date of wrangler.toml. A stand-in that an RPC entrypoint lives in needs it spelled out.
const COMPATIBILITY_DATE = '2026-10-12';

// Stands in for newscast-worker, with the NewscastTaskGroup entrypoint the NEWSCAST binding names.
// startTaskGroupRun records the request and returns, as the real group does after it starts its work.
//
// GET /__test__/calls answers the requests received, oldest first.
// POST /__test__/reset forgets them.
const NEWSCAST_SCRIPT = `
import { WorkerEntrypoint } from 'cloudflare:workers';

const calls = [];

export class NewscastTaskGroup extends WorkerEntrypoint {
  async startTaskGroupRun(request) {
    calls.push(request);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/calls') return Response.json(calls);
    if (url.pathname === '/__test__/reset') {
      calls.length = 0;
      return Response.json({ reset: true });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
};
`;

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
          {
            name: 'audio-underview-newscast-worker',
            compatibilityDate: COMPATIBILITY_DATE,
            modules: true,
            script: NEWSCAST_SCRIPT,
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
