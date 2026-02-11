import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            APPLE_CLIENT_ID: 'test-apple-client-id',
            APPLE_TEAM_ID: 'test-team-id',
            APPLE_KEY_ID: 'test-key-id',
            APPLE_PRIVATE_KEY:
              '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgvY6PKmRlVMJ86LDK8GZWtnCWdhVx7Zc+H199BxJSv2GhRANCAAQ9ONrL9gmYH9whdml1B3juiAaVXyKpHgVYytrrAuPRXHdUki5NT5O5p/X8+dMGzG0EEuJCENbTdVB2aWK+K86O\n-----END PRIVATE KEY-----',
            FRONTEND_URL: 'https://example.com',
          },
        },
      },
    },
  },
});
