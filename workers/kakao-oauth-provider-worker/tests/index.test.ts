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

describe('kakao-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Kakao authorization endpoint', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://kauth.kakao.com');
      expect(redirectURL.pathname).toBe('/oauth/authorize');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-kakao-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      expect(redirectURL.searchParams.get('scope')).toBe('profile_nickname,profile_image,account_email');
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

    it('redirects with error when token exchange fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://kauth.kakao.com')
        .intercept({ path: '/oauth/token', method: 'POST' })
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
        .get('https://kauth.kakao.com')
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      fetchMock
        .get('https://kapi.kakao.com')
        .intercept({ path: '/v2/user/me', method: 'GET' })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow with nested Kakao user data', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://kauth.kakao.com')
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 7200,
          scope: 'profile_nickname profile_image account_email',
        }));

      fetchMock
        .get('https://kapi.kakao.com')
        .intercept({ path: '/v2/user/me', method: 'GET' })
        .reply(200, JSON.stringify({
          id: 12345,
          connected_at: '2024-01-01T00:00:00Z',
          kakao_account: {
            email: 'test@example.com',
            is_email_valid: true,
            is_email_verified: true,
            profile: {
              nickname: 'Test User',
              thumbnail_image_url: 'https://k.kakaocdn.net/thumb.jpg',
              profile_image_url: 'https://k.kakaocdn.net/profile.jpg',
              is_default_image: false,
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
      expect(user.id).toBe('12345');
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.picture).toBe('https://k.kakaocdn.net/profile.jpg');
      expect(user.provider).toBe('kakao');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('falls back to KakaoUser{id} when no nickname is available', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://kauth.kakao.com')
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      fetchMock
        .get('https://kapi.kakao.com')
        .intercept({ path: '/v2/user/me', method: 'GET' })
        .reply(200, JSON.stringify({
          id: 67890,
          kakao_account: {},
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      const userParameter = redirectURL.searchParams.get('user');
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user.id).toBe('67890');
      expect(user.name).toBe('KakaoUser67890');
      expect(user.email).toBe('67890@kakao.com');
      expect(user.provider).toBe('kakao');
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
      expect(body).toEqual({ status: 'healthy', provider: 'kakao' });
    });
  });
});
