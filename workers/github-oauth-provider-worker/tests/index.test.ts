import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@audio-underview/axiom-logger', () => ({
  instrumentWorker: vi.fn((handler: unknown) => handler),
}));

vi.mock('@audio-underview/supabase-connector', () => ({
  createSupabaseClient: vi.fn(() => ({})),
  handleSocialLogin: vi.fn(async () => ({
    userUUID: 'test-uuid-12345',
    isNewUser: false,
    isNewAccount: false,
  })),
}));

import { env, fetchMock } from 'cloudflare:test';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('github-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to GitHub authorization endpoint', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://github.com');
      expect(redirectURL.pathname).toBe('/login/oauth/authorize');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-github-client-id');
      expect(redirectURL.searchParams.get('scope')).toBe('user:email');
      expect(redirectURL.searchParams.get('state')).toBeTruthy();
    });

    it('stores state in KV with redirect_uri', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      const location = response.headers.get('Location')!;
      const state = new URL(location).searchParams.get('state')!;
      const storedValue = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
      expect(storedValue).toBe('https://app.example.com/callback');
    });
  });

  describe('handleCallback', () => {
    it('redirects with error when provider returns error', async () => {
      const request = new Request(`${WORKER_URL}/callback?error=access_denied&error_description=User%20denied`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=access_denied');
    });

    it('redirects with error when code is missing', async () => {
      const request = new Request(`${WORKER_URL}/callback?state=test-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_request');
    });

    it('redirects with error when state is invalid', async () => {
      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=invalid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_state');
    });

    it('redirects with error when token exchange HTTP request fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://github.com')
        .intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('redirects with error when token response body contains error field (200 with error)', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://github.com')
        .intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(200, JSON.stringify({
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        }));

      const request = new Request(`${WORKER_URL}/callback?code=expired-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=bad_verification_code');
      expect(location).toContain('error_description=');
    });

    it('redirects with error when user info fetch fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://github.com')
        .intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
        }));

      fetchMock
        .get('https://api.github.com')
        .intercept({ path: '/user', method: 'GET' })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow with email in profile', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://github.com')
        .intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
          scope: 'user:email',
        }));

      fetchMock
        .get('https://api.github.com')
        .intercept({ path: '/user', method: 'GET' })
        .reply(200, JSON.stringify({
          id: 12345,
          login: 'testuser',
          email: 'test@example.com',
          name: 'Test User',
          avatar_url: 'https://avatars.githubusercontent.com/u/12345',
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://app.example.com');

      const userParameter = redirectURL.searchParams.get('user');
      expect(userParameter).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user.id).toBe('12345');
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.provider).toBe('github');
      expect(user.picture).toBe('https://avatars.githubusercontent.com/u/12345');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.get('uuid')).toBe('test-uuid-12345');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('fetches email from /user/emails when email is not in profile', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://github.com')
        .intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
          scope: 'user:email',
        }));

      fetchMock
        .get('https://api.github.com')
        .intercept({ path: '/user', method: 'GET' })
        .reply(200, JSON.stringify({
          id: 67890,
          login: 'noemailer',
          email: null,
          name: 'No Email User',
          avatar_url: 'https://avatars.githubusercontent.com/u/67890',
        }));

      fetchMock
        .get('https://api.github.com')
        .intercept({ path: '/user/emails', method: 'GET' })
        .reply(200, JSON.stringify([
          { email: 'secondary@example.com', primary: false, verified: true, visibility: null },
          { email: 'primary@example.com', primary: true, verified: true, visibility: 'public' },
        ]));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);

      const userParameter = redirectURL.searchParams.get('user');
      expect(userParameter).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user.id).toBe('67890');
      expect(user.email).toBe('primary@example.com');
      expect(user.name).toBe('No Email User');
      expect(user.provider).toBe('github');

      expect(redirectURL.searchParams.get('uuid')).toBe('test-uuid-12345');
    });
  });

  describe('health check', () => {
    it('returns healthy status', async () => {
      const request = new Request(`${WORKER_URL}/health`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'healthy', provider: 'github' });
    });
  });
});
