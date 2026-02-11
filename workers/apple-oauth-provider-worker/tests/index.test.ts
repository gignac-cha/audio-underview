import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import worker from '../sources/index.ts';
import { createMockJWT } from '@audio-underview/worker-tools/tests/mock-jwt.ts';

const WORKER_URL = 'https://worker.example.com';

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.deactivate();
});

describe('apple-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Apple authorization endpoint', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://appleid.apple.com');
      expect(redirectURL.pathname).toBe('/auth/authorize');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-apple-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      expect(redirectURL.searchParams.get('scope')).toBe('name email');
      expect(redirectURL.searchParams.get('state')).toBeTruthy();
      expect(redirectURL.searchParams.get('nonce')).toBeTruthy();
      expect(redirectURL.searchParams.get('response_mode')).toBe('form_post');
    });

    it('stores JSON state { redirectURI, nonce } in KV', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      const state = redirectURL.searchParams.get('state')!;
      const nonce = redirectURL.searchParams.get('nonce')!;

      const storedValue = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
      expect(storedValue).toBeTruthy();

      const stateData = JSON.parse(storedValue!);
      expect(stateData.redirectURI).toBe('https://app.example.com/callback');
      expect(stateData.nonce).toBe(nonce);
    });
  });

  describe('handleCallback', () => {
    it('redirects with error when provider returns error via POST FormData', async () => {
      const formData = new FormData();
      formData.append('error', 'access_denied');
      formData.append('error_description', 'User denied');

      const request = new Request(`${WORKER_URL}/callback`, {
        method: 'POST',
        body: formData,
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=access_denied');
    });

    it('redirects with error when code or state is missing', async () => {
      const formData = new URLSearchParams();
      formData.append('state', 'test-state');

      const request = new Request(`${WORKER_URL}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_request');
    });

    it('redirects with error when state is invalid', async () => {
      const formData = new URLSearchParams();
      formData.append('code', 'test-code');
      formData.append('state', 'invalid-state');

      const request = new Request(`${WORKER_URL}/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData,
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_state');
    });

    it('redirects with error when token exchange fails', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      fetchMock
        .get('https://appleid.apple.com')
        .intercept({ path: '/auth/token', method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('redirects with error when id_token is missing from token response', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      fetchMock
        .get('https://appleid.apple.com')
        .intercept({ path: '/auth/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=missing_id_token');
    });

    it('completes full OAuth flow with id_token and redirects with user data', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      const mockIDToken = createMockJWT({
        sub: 'apple-user-001',
        email: 'test@privaterelay.appleid.com',
        email_verified: true,
        is_private_email: true,
      });

      const mockUserJSON = JSON.stringify({
        name: {
          firstName: 'John',
          lastName: 'Doe',
        },
      });

      fetchMock
        .get('https://appleid.apple.com')
        .intercept({ path: '/auth/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          id_token: mockIDToken,
        }));

      const formData = new FormData();
      formData.append('code', 'test-code');
      formData.append('state', 'valid-state');
      formData.append('user', mockUserJSON);

      const request = new Request(`${WORKER_URL}/callback`, {
        method: 'POST',
        body: formData,
      });
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://app.example.com');

      const userParameter = redirectURL.searchParams.get('user');
      expect(userParameter).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user.id).toBe('apple-user-001');
      expect(user.email).toBe('test@privaterelay.appleid.com');
      expect(user.name).toBe('John Doe');
      expect(user.provider).toBe('apple');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.get('id_token')).toBe(mockIDToken);

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
      expect(body).toEqual({ status: 'healthy', provider: 'apple' });
    });
  });
});
