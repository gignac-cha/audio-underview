import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('facebook-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Facebook authorization endpoint with correct params', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://www.facebook.com');
      expect(redirectURL.pathname).toBe('/v22.0/dialog/oauth');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-facebook-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      expect(redirectURL.searchParams.get('scope')).toBe('email,public_profile');
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

    it('redirects with error when state is missing', async () => {
      const request = new Request(`${WORKER_URL}/callback?code=test-code`);
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
        .get('https://graph.facebook.com')
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/oauth/access_token'),
          method: 'GET',
        })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('redirects with error when user info fetch fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://graph.facebook.com')
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/oauth/access_token'),
          method: 'GET',
        })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
        }));

      fetchMock
        .get('https://graph.facebook.com')
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/me'),
          method: 'GET',
        })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow and redirects with user data', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://graph.facebook.com')
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/oauth/access_token'),
          method: 'GET',
        })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'bearer',
          expires_in: 5183944,
        }));

      fetchMock
        .get('https://graph.facebook.com')
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/me'),
          method: 'GET',
        })
        .reply(200, JSON.stringify({
          id: '1234567890',
          email: 'testuser@example.com',
          name: 'Test User',
          first_name: 'Test',
          last_name: 'User',
          picture: {
            data: {
              url: 'https://platform-lookaside.fbsbx.com/profile-pic-123.jpg',
              width: 50,
              height: 50,
              is_silhouette: false,
            },
          },
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
      expect(user.id).toBe('1234567890');
      expect(user.email).toBe('testuser@example.com');
      expect(user.name).toBe('Test User');
      expect(user.provider).toBe('facebook');
      expect(user.picture).toBe('https://platform-lookaside.fbsbx.com/profile-pic-123.jpg');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });
  });

  describe('health check', () => {
    it('returns healthy status with provider facebook', async () => {
      const request = new Request(`${WORKER_URL}/health`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'healthy', provider: 'facebook' });
    });
  });
});
