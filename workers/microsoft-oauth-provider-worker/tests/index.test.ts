import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@audio-underview/axiom-logger', () => ({
  instrumentWorker: vi.fn((handler: unknown) => handler),
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

describe('microsoft-oauth-provider-worker', () => {
  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const request = new Request(`${WORKER_URL}/authorize`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('redirects to Microsoft authorization endpoint with nonce', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://login.microsoftonline.com');
      expect(redirectURL.pathname).toBe('/common/oauth2/v2.0/authorize');
      expect(redirectURL.searchParams.get('client_id')).toBe('test-microsoft-client-id');
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      expect(redirectURL.searchParams.get('scope')).toBe('openid email profile');
      expect(redirectURL.searchParams.get('state')).toBeTruthy();
      expect(redirectURL.searchParams.get('nonce')).toBeTruthy();
      expect(redirectURL.searchParams.get('prompt')).toBe('select_account');
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

    it('redirects with error when state is invalid or expired', async () => {
      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=nonexistent-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_state');
    });

    it('redirects with error when state data is corrupted (invalid JSON) and cleans up KV', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('corrupted-state', 'not-valid-json{{{');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=corrupted-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_state');

      // Verify KV entry was cleaned up
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('corrupted-state');
      expect(remainingState).toBeNull();
    });

    it('redirects with error when token exchange fails', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      fetchMock
        .get('https://login.microsoftonline.com')
        .intercept({ path: '/common/oauth2/v2.0/token', method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=valid-state`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('completes OAuth flow with id_token (no Graph API call)', async () => {
      const nonce = 'test-nonce-value';
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      const mockIDToken = createMockJWT({
        sub: 'microsoft-user-id-123',
        email: 'user@example.com',
        name: 'Test User',
        preferred_username: 'user@example.com',
        nonce,
        oid: 'object-id-456',
        tid: 'tenant-id-789',
      });

      fetchMock
        .get('https://login.microsoftonline.com')
        .intercept({ path: '/common/oauth2/v2.0/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          id_token: mockIDToken,
          expires_in: 3600,
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
      expect(user.id).toBe('microsoft-user-id-123');
      expect(user.email).toBe('user@example.com');
      expect(user.name).toBe('Test User');
      expect(user.provider).toBe('microsoft');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.get('id_token')).toBe(mockIDToken);

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('completes OAuth flow without id_token (falls back to Graph API)', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      fetchMock
        .get('https://login.microsoftonline.com')
        .intercept({ path: '/common/oauth2/v2.0/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
          scope: 'openid email profile',
        }));

      fetchMock
        .get('https://graph.microsoft.com')
        .intercept({ path: '/v1.0/me', method: 'GET' })
        .reply(200, JSON.stringify({
          id: 'graph-user-id-456',
          displayName: 'Graph Test User',
          mail: 'graphuser@example.com',
          userPrincipalName: 'graphuser@example.com',
          givenName: 'Graph',
          surname: 'User',
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
      expect(user.id).toBe('graph-user-id-456');
      expect(user.email).toBe('graphuser@example.com');
      expect(user.name).toBe('Graph Test User');
      expect(user.provider).toBe('microsoft');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      // No id_token should be in redirect params
      expect(redirectURL.searchParams.has('id_token')).toBe(false);

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('valid-state');
      expect(remainingState).toBeNull();
    });

    it('redirects with error when Graph API fails', async () => {
      const stateData = JSON.stringify({ redirectURI: 'https://app.example.com/callback', nonce: 'test-nonce' });
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put('valid-state', stateData);

      fetchMock
        .get('https://login.microsoftonline.com')
        .intercept({ path: '/common/oauth2/v2.0/token', method: 'POST' })
        .reply(200, JSON.stringify({
          access_token: 'mock-access-token',
          token_type: 'Bearer',
        }));

      fetchMock
        .get('https://graph.microsoft.com')
        .intercept({ path: '/v1.0/me', method: 'GET' })
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
      expect(body).toEqual({ status: 'healthy', provider: 'microsoft' });
    });
  });
});
