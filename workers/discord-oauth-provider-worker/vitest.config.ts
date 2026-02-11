import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            DISCORD_CLIENT_ID: 'test-discord-client-id',
            DISCORD_CLIENT_SECRET: 'test-discord-client-secret',
            FRONTEND_URL: 'https://example.com',
          },
        },
      },
    },
  },
});
