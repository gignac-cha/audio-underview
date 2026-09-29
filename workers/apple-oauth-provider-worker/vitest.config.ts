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
            // Throwaway P-256 test key: it only signs the client secret JWT
            // that the mocked token endpoint receives.
            APPLE_PRIVATE_KEY:
              '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgvY6PKmRlVMJ86LDK8GZWtnCWdhVx7Zc+H199BxJSv2GhRANCAAQ9ONrL9gmYH9whdml1B3juiAaVXyKpHgVYytrrAuPRXHdUki5NT5O5p/X8+dMGzG0EEuJCENbTdVB2aWK+K86O\n-----END PRIVATE KEY-----',
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
      },
    },
  },
});
