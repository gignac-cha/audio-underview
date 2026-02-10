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

function createMockJWT(payload: Record<string, unknown>): string {
  const base64URLEncode = (data: string): string =>
    btoa(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = base64URLEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const body = base64URLEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('google-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Google authorization endpoint', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://accounts.google.com');
      expect(redirectURL.pathname).toBe('/o/oauth2/v2/auth');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-google-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      expect(redirectURL.searchParams.get('scope')).toBe('openid email profile');
      expect(redirectURL.searchParams.get('state')).toBeTruthy();
      expect(redirectURL.searchParams.get('access_type')).toBe('online');
      expect(redirectURL.searchParams.get('prompt')).toBe('select_account');
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

    it('redirects with error when token exchange fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://oauth2.googleapis.com')
        .intercept({ path: '/token', method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('completes OAuth flow with id_token (skips user info endpoint)', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      const mockIDToken = createMockJWT({
        sub: 'google-user-123',
        email: 'test@gmail.com',
        email_verified: true,
        name: 'Test Google User',
        picture: 'https://lh3.googleusercontent.com/photo.jpg',
        given_name: 'Test',
        family_name: 'User',
      });

      fetchMock
        .get('https://oauth2.googleapis.com')
        .intercept({ path: '/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: mockIDToken,
          scope: 'openid email profile',
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
      expect(user.id).toBe('google-user-123');
      expect(user.email).toBe('test@gmail.com');
      expect(user.name).toBe('Test Google User');
      expect(user.picture).toBe('https://lh3.googleusercontent.com/photo.jpg');
      expect(user.provider).toBe('google');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.get('id_token')).toBe(mockIDToken);
      expect(redirectURL.searchParams.get('uuid')).toBe('test-uuid-12345');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('completes OAuth flow without id_token (falls back to user info endpoint)', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://oauth2.googleapis.com')
        .intercept({ path: '/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          scope: 'openid email profile',
        }));

      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(200, JSON.stringify({
          sub: 'google-user-456',
          email: 'fallback@gmail.com',
          email_verified: true,
          name: 'Fallback User',
          picture: 'https://lh3.googleusercontent.com/fallback.jpg',
          given_name: 'Fallback',
          family_name: 'User',
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
      expect(user.id).toBe('google-user-456');
      expect(user.email).toBe('fallback@gmail.com');
      expect(user.name).toBe('Fallback User');
      expect(user.picture).toBe('https://lh3.googleusercontent.com/fallback.jpg');
      expect(user.provider).toBe('google');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.has('id_token')).toBe(false);
      expect(redirectURL.searchParams.get('uuid')).toBe('test-uuid-12345');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('redirects with error when user info endpoint fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://oauth2.googleapis.com')
        .intercept({ path: '/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          scope: 'openid email profile',
        }));

      fetchMock
        .get('https://www.googleapis.com')
        .intercept({ path: '/oauth2/v3/userinfo', method: 'GET' })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
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
      expect(body).toEqual({ status: 'healthy', provider: 'google' });
    });
  });
});
