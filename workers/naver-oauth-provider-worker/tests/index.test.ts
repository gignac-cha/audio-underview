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

describe('naver-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Naver authorization endpoint', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://nid.naver.com');
      expect(redirectURL.pathname).toBe('/oauth2.0/authorize');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-naver-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
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

    it('redirects with error when token exchange fails with HTTP error', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://nid.naver.com')
        .intercept({ path: /^\/oauth2\.0\/token\?/, method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('redirects with error when token response contains error field', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://nid.naver.com')
        .intercept({ path: /^\/oauth2\.0\/token\?/, method: 'POST' })
        .reply(200, JSON.stringify({
          error: 'invalid_request',
          error_description: 'The request is missing a required parameter',
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('redirects with error when user info fetch fails', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://nid.naver.com')
        .intercept({ path: /^\/oauth2\.0\/token\?/, method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      fetchMock
        .get('https://openapi.naver.com')
        .intercept({ path: '/v1/nid/me', method: 'GET' })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('redirects with error when user info resultcode is not 00', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://nid.naver.com')
        .intercept({ path: /^\/oauth2\.0\/token\?/, method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      fetchMock
        .get('https://openapi.naver.com')
        .intercept({ path: '/v1/nid/me', method: 'GET' })
        .reply(200, JSON.stringify({
          resultcode: '024',
          message: 'Authentication failed',
          response: {},
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow and returns auto-submitting form with user data', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', 'https://app.example.com/callback');

      fetchMock
        .get('https://nid.naver.com')
        .intercept({ path: /^\/oauth2\.0\/token\?/, method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'mock-refresh-token',
        }));

      fetchMock
        .get('https://openapi.naver.com')
        .intercept({ path: '/v1/nid/me', method: 'GET' })
        .reply(200, JSON.stringify({
          resultcode: '00',
          message: 'success',
          response: {
            id: '12345',
            email: 'test@example.com',
            name: 'Test User',
            nickname: 'tester',
            profile_image: 'https://phinf.pstatic.net/contact/profile.png',
          },
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');

      const html = await response.text();
      expect(html).toContain('action="https://app.example.com/callback"');
      expect(html).toContain('method="POST"');
      expect(html).toContain('name="access_token"');
      expect(html).toContain('value="mock-access-token"');
      expect(html).toContain('name="user"');

      // Verify user data is in the form
      const userMatch = html.match(/name="user"\s+value="([^"]+)"/);
      expect(userMatch).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userMatch![1]));
      expect(user.id).toBe('12345');
      expect(user.email).toBe('test@example.com');
      expect(user.name).toBe('Test User');
      expect(user.provider).toBe('naver');
      expect(user.picture).toBe('https://phinf.pstatic.net/contact/profile.png');

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
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
      expect(body).toEqual({ status: 'healthy', provider: 'naver' });
    });
  });
});
