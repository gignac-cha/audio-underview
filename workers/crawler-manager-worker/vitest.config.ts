import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Stands in for user-vault-worker. A test sets the answers of each route for a user with
// POST /__test__/configure { userId, responses: { <route>: { status, body } } } and reads the
// requests the vault received for a user with GET /__test__/requests?userId=<user>. A route is
// named by what follows /internal/environment-variables/ (list, put, delete, resolve), or, for the
// provider key routes, by what follows /internal/ (keys/status, keys/audit, keys/put, keys/delete).
// A user without configured answers resolves to no variables. Answers are kept per user, so test
// files running side by side do not see each other's.
const USER_VAULT_SCRIPT = `
const responsesByUser = new Map();
const requests = [];
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__test__/configure') {
      const { userId, responses } = await request.json();
      responsesByUser.set(userId, responses);
      return Response.json({ configured: true });
    }
    if (url.pathname === '/__test__/requests') {
      const userId = url.searchParams.get('userId');
      return Response.json(requests.filter((entry) => entry.userId === userId));
    }
    let body = null;
    try {
      body = await request.json();
    } catch {}
    const userId = body !== null && typeof body === 'object' ? body.userId : undefined;
    const route = url.pathname.startsWith('/internal/keys/')
      ? url.pathname.replace('/internal/', '')
      : url.pathname.replace('/internal/environment-variables/', '');
    requests.push({ userId, route, method: request.method, token: request.headers.get('x-user-vault-token'), body });
    const response = (responsesByUser.get(userId) ?? {})[route];
    if (response === undefined) {
      if (route === 'resolve') return Response.json({ variables: {} });
      return Response.json({ error: 'not_configured' }, { status: 500 });
    }
    if (response.status === 'unreachable') {
      throw new Error('vault is down');
    }
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
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
          CODE_RUNNER_FUNCTION_URL: 'https://code-runner.example.com',
          VAULT_INTERNAL_TOKEN: 'test-vault-token',
        },
        workers: [
          {
            name: 'audio-underview-user-vault-worker',
            modules: true,
            script: USER_VAULT_SCRIPT,
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
