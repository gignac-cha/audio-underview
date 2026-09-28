import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@audio-underview/axiom-logger', () => ({
  instrumentWorker: vi.fn((handler: unknown) => handler),
}));

import { env, fetchMock } from 'cloudflare:test';
import { instrumentWorker } from '@audio-underview/axiom-logger';
import { signJWT, verifyJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';
const SUPABASE_ORIGIN = 'https://test.supabase.co';
const FACEBOOK_GRAPH_ORIGIN = 'https://graph.facebook.com';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const ACCOUNT_UUID = '83156cb5-c92a-4c75-b944-341d2d857bbf';
const OTHER_ACCOUNT_UUID = '11111111-2222-3333-4444-555555555555';
const FACEBOOK_USER_ID = '1234567890';

function facebookAccountRow(uuid: string = ACCOUNT_UUID) {
  return { provider: 'facebook', identifier: FACEBOOK_USER_ID, uuid, created_at: '2026-01-01T00:00:00+00:00' };
}

function googleAccountRow(uuid: string = ACCOUNT_UUID) {
  return { provider: 'google', identifier: 'google-sub-1', uuid, created_at: '2026-08-01T00:00:00+00:00' };
}

function interceptSupabase(
  method: 'GET' | 'POST' | 'DELETE',
  table: string,
  status: number,
  body: unknown,
) {
  fetchMock
    .get(SUPABASE_ORIGIN)
    .intercept({ path: new RegExp(`^/rest/v1/${table}`), method })
    .reply(status, JSON.stringify(body))
    .persist();
}

/**
 * A paused Supabase project answers with a Cloudflare error page rather than a
 * PostgREST payload, which the connector surfaces as a thrown error.
 */
function interceptSupabaseOutage() {
  fetchMock
    .get(SUPABASE_ORIGIN)
    .intercept({ path: /^\/rest\/v1\//, method: 'GET' })
    .reply(503, JSON.stringify({ message: 'error code: 1016' }))
    .persist();
}

function interceptAccountMissing() {
  interceptSupabase('GET', 'accounts', 406, {
    code: 'PGRST116',
    details: 'The result contains 0 rows',
    hint: null,
    message: 'JSON object requested, multiple (or no) rows returned',
  });
}

/**
 * Facebook exchanges the code over GET, so the interceptor matches on the path
 * prefix and hands every matched path (query string included) to `onPath`.
 */
function interceptTokenExchange(onPath: (path: string) => void = () => {}) {
  fetchMock
    .get(FACEBOOK_GRAPH_ORIGIN)
    .intercept({
      path: (path: string) => {
        if (!path.startsWith('/v22.0/oauth/access_token')) {
          return false;
        }
        onPath(path);
        return true;
      },
      method: 'GET',
    })
    .reply(200, JSON.stringify({
      access_token: 'mock-access-token',
      token_type: 'bearer',
      expires_in: 5183944,
    }));
}

function interceptUserInfo(
  overrides: Record<string, unknown> = {},
  onPath: (path: string) => void = () => {},
) {
  fetchMock
    .get(FACEBOOK_GRAPH_ORIGIN)
    .intercept({
      path: (path: string) => {
        if (!path.startsWith('/v22.0/me')) {
          return false;
        }
        onPath(path);
        return true;
      },
      method: 'GET',
    })
    .reply(200, JSON.stringify({
      id: FACEBOOK_USER_ID,
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
      ...overrides,
    }));
}

/**
 * The state is handed to the shared `verifyState` as a KV key, so the worker
 * refuses anything that is not the 32-character alphanumeric shape
 * `generateState()` emits (otherwise a crafted state names an
 * `account/{provider}/{identifier}` cache entry and deletes it). These tests
 * still want readable names, so pad one into that shape.
 */
function oauthState(label: string): string {
  return label.replace(/[^A-Za-z0-9]/g, '').padEnd(32, '0').slice(0, 32);
}

async function putAuthorizationState(
  state: string,
  value: { redirectURI: string; linkTicket?: string },
) {
  await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(value));
}

/** Stand-in for the nonce the SPA keeps in sessionStorage. */
const LINK_NONCE = 'cb0d6e2a-6ad4-4c74-9b2a-2a2b6a2f0e11';

async function putLinkTicket(
  ticket: string,
  uuid: string = ACCOUNT_UUID,
  nonce: string = LINK_NONCE,
) {
  await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`link-ticket/${ticket}`, JSON.stringify({ uuid, nonce }));
}

async function createSessionToken(subject: string = ACCOUNT_UUID): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return signJWT({ sub: subject, provider: 'facebook', iat: issuedAt, exp: issuedAt + 86_400 }, JWT_SECRET);
}

function authorizedRequest(path: string, method: string, token: string): Request {
  return new Request(`${WORKER_URL}${path}`, {
    method,
    headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
  });
}

function linkConfirmRequest(token: string, body: unknown): Request {
  return new Request(`${WORKER_URL}/accounts/link-confirm`, {
    method: 'POST',
    headers: {
      Origin: 'https://example.com',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Drives a link flow the way the SPA does — mint a ticket over the
 * authenticated route, then let the OAuth callback come back — and returns the
 * two secrets the confirmation needs. The caller registers the provider
 * interceptors and decides who confirms.
 */
async function startLinkFlow(state: string, subject: string = ACCOUNT_UUID) {
  const token = await createSessionToken(subject);
  const ticketResponse = await worker.fetch(authorizedRequest('/link-tickets', 'POST', token), env);
  const { ticket, nonce } = await ticketResponse.json() as { ticket: string; nonce: string };

  await putAuthorizationState(state, {
    redirectURI: 'https://app.example.com/settings',
    linkTicket: ticket,
  });

  const callbackResponse = await worker.fetch(
    new Request(`${WORKER_URL}/callback?code=test-code&state=${state}`),
    env,
  );
  const redirectURL = new URL(callbackResponse.headers.get('Location')!);

  return { token, nonce, redirectURL, linkCode: redirectURL.searchParams.get('link_code') };
}

/** Origins that get intercepted; their mocks are reset between tests. */
const MOCK_ORIGINS = [SUPABASE_ORIGIN, FACEBOOK_GRAPH_ORIGIN];

beforeEach(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  // Interceptors (especially persisted ones) outlive a single test otherwise.
  for (const origin of MOCK_ORIGINS) {
    fetchMock.get(origin).cleanMocks();
  }
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
      expect(redirectURL.searchParams.get('redirect_uri')).toBe(`${WORKER_URL}/callback`);
      expect(redirectURL.searchParams.get('response_type')).toBe('code');
      // Facebook takes comma-separated scopes.
      expect(redirectURL.searchParams.get('scope')).toBe('email,public_profile');
      expect(redirectURL.searchParams.get('state')).toBeTruthy();
    });

    it('stores state in KV with redirect_uri', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      const location = response.headers.get('Location')!;
      const state = new URL(location).searchParams.get('state')!;
      const storedValue = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(state);
      expect(JSON.parse(storedValue!)).toEqual({ redirectURI: 'https://app.example.com/callback' });
    });

    it('refuses a redirect_uri that is not an allowed origin', async () => {
      const request = new Request(
        `${WORKER_URL}/authorize?redirect_uri=https://evil.example.net/steal`,
      );
      const response = await worker.fetch(request, env);

      // The callback would otherwise deliver access_token + session_token there.
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('not an allowed origin');
    });

    it('refuses a redirect_uri that is not an http(s) URL', async () => {
      const request = new Request(
        `${WORKER_URL}/authorize?redirect_uri=${encodeURIComponent('javascript:alert(1)')}`,
      );
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(400);
    });

    it('carries the link ticket through the state so the JWT never enters a URL', async () => {
      const request = new Request(
        `${WORKER_URL}/authorize?redirect_uri=https://app.example.com/settings&link_ticket=ticket-1`,
        { headers: { Referer: 'https://app.example.com/settings' } },
      );
      const response = await worker.fetch(request, env);

      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      const state = redirectURL.searchParams.get('state')!;

      expect(JSON.parse((await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(state))!)).toEqual({
        redirectURI: 'https://app.example.com/settings',
        linkTicket: 'ticket-1',
      });
      // The ticket is state, not something Facebook ever sees.
      expect(location).not.toContain('ticket-1');
    });

    it('starts a link flow whatever the Referer says, because it proves nothing', async () => {
      // This endpoint is a cookie-less GET, so an attacker sets any Referer
      // they like from their own server. A Referer check would cost
      // Referer-stripping browsers the feature and buy no security; the binding
      // is enforced at POST /accounts/link-confirm instead (see the link CSRF
      // test below).
      for (const headers of [
        { Referer: 'https://evil.example.net/bait' },
        {} as Record<string, string>,
      ]) {
        const response = await worker.fetch(
          new Request(
            `${WORKER_URL}/authorize?redirect_uri=https://app.example.com/settings&link_ticket=some-ticket`,
            { headers },
          ),
          env,
        );

        expect(response.status).toBe(302);
      }
    });

    it('still allows a plain login with no Referer', async () => {
      const request = new Request(`${WORKER_URL}/authorize?redirect_uri=https://app.example.com/callback`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
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

    it('redirects with error for a well formed state that is not in KV', async () => {
      const request = new Request(
        `${WORKER_URL}/callback?code=test-code&state=${oauthState('neverissued')}`,
      );
      const response = await worker.fetch(request, env);

      expect(response.headers.get('Location')!).toContain('error=invalid_state');
    });

    it('cannot be used to delete an account cache entry through the state key', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/facebook/${FACEBOOK_USER_ID}`, ACCOUNT_UUID);

      const request = new Request(
        `${WORKER_URL}/callback?code=anything&state=${encodeURIComponent(`account/facebook/${FACEBOOK_USER_ID}`)}`,
      );
      const response = await worker.fetch(request, env);

      expect(response.headers.get('Location')!).toContain('error=invalid_state');
      // The state KV namespace also holds the Supabase-outage fallback; an
      // unauthenticated request must not be able to erase it.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBe(ACCOUNT_UUID);
    });

    it('refuses a stored redirect_uri that is not an allowed origin', async () => {
      await putAuthorizationState(oauthState('foreign'), { redirectURI: 'https://evil.example.net/steal' });

      // No interceptors on purpose: the refusal happens before the code is ever
      // exchanged, so any outbound call here would fail the test.
      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('foreign')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('invalid_redirect_uri');
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
    });

    it('redirects with error when token exchange fails', async () => {
      await putAuthorizationState(oauthState('valid'), { redirectURI: 'https://app.example.com/callback' });

      fetchMock
        .get(FACEBOOK_GRAPH_ORIGIN)
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/oauth/access_token'),
          method: 'GET',
        })
        .reply(400, JSON.stringify({
          error: {
            message: 'This authorization code has expired.',
            type: 'OAuthException',
            code: 100,
          },
        }));

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('valid')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('exchanges the code over GET with the client credentials in the query', async () => {
      await putAuthorizationState(oauthState('tokenquery'), { redirectURI: 'https://app.example.com/callback' });

      let tokenExchangePath = '';
      interceptTokenExchange((path) => {
        tokenExchangePath = path;
      });
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('tokenquery')}`);
      const response = await worker.fetch(request, env);

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBeNull();

      const tokenExchangeParameters = new URL(tokenExchangePath, FACEBOOK_GRAPH_ORIGIN).searchParams;
      expect(tokenExchangeParameters.get('client_id')).toBe('test-facebook-client-id');
      expect(tokenExchangeParameters.get('client_secret')).toBe('test-facebook-client-secret');
      expect(tokenExchangeParameters.get('code')).toBe('test-code');
      expect(tokenExchangeParameters.get('redirect_uri')).toBe(`${WORKER_URL}/callback`);
    });

    it('requests the profile fields with the access token in the query', async () => {
      await putAuthorizationState(oauthState('userquery'), { redirectURI: 'https://app.example.com/callback' });

      let userInfoPath = '';
      interceptTokenExchange();
      interceptUserInfo({}, (path) => {
        userInfoPath = path;
      });
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('userquery')}`);
      await worker.fetch(request, env);

      const userInfoParameters = new URL(userInfoPath, FACEBOOK_GRAPH_ORIGIN).searchParams;
      expect(userInfoParameters.get('fields')).toBe('id,email,name,first_name,last_name,picture');
      expect(userInfoParameters.get('access_token')).toBe('mock-access-token');
    });

    it('redirects with error when user info fetch fails', async () => {
      await putAuthorizationState(oauthState('valid'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();

      fetchMock
        .get(FACEBOOK_GRAPH_ORIGIN)
        .intercept({
          path: (path: string) => path.startsWith('/v22.0/me'),
          method: 'GET',
        })
        .reply(401, 'Unauthorized');

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('valid')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow and redirects with user data', async () => {
      await putAuthorizationState(oauthState('valid'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('valid')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://app.example.com');

      const userParameter = redirectURL.searchParams.get('user');
      expect(userParameter).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user.id).toBe(FACEBOOK_USER_ID);
      expect(user.email).toBe('testuser@example.com');
      expect(user.name).toBe('Test User');
      expect(user.provider).toBe('facebook');
      expect(user.picture).toBe('https://platform-lookaside.fbsbx.com/profile-pic-123.jpg');

      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(oauthState('valid'));
      expect(remainingState).toBeNull();
    });

    it('omits email when Facebook does not return one instead of inventing an address', async () => {
      await putAuthorizationState(oauthState('noemail'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo({ email: undefined });
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('noemail')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('error')).toBeNull();

      const userParameter = decodeURIComponent(redirectURL.searchParams.get('user')!);
      const user = JSON.parse(userParameter);
      expect(user.id).toBe(FACEBOOK_USER_ID);
      expect(user.email).toBeUndefined();
      expect(userParameter).not.toContain('@facebook.com');
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);
    });

    it('builds the name from first_name and last_name when name is missing', async () => {
      await putAuthorizationState(oauthState('splitname'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo({ name: undefined, first_name: 'Given', last_name: 'Family' });
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('splitname')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      const user = JSON.parse(decodeURIComponent(redirectURL.searchParams.get('user')!));
      expect(user.name).toBe('Given Family');
    });

    it('falls back to the account id when Facebook returns no name at all', async () => {
      await putAuthorizationState(oauthState('noname'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo({ name: undefined, first_name: undefined, last_name: undefined, picture: undefined });
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('noname')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      const user = JSON.parse(decodeURIComponent(redirectURL.searchParams.get('user')!));
      expect(user.name).toBe(FACEBOOK_USER_ID);
      expect(user.picture).toBeUndefined();
    });

    it('issues a session JWT whose sub is the account UUID and which carries no jid', async () => {
      await putAuthorizationState(oauthState('session'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('session')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      const sessionToken = redirectURL.searchParams.get('session_token');
      expect(sessionToken).toBeTruthy();

      const payload = await verifyJWT(sessionToken!, JWT_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(ACCOUNT_UUID);
      expect(payload!.provider).toBe('facebook');
      expect(payload!.exp - payload!.iat).toBe(86_400);
      // A `jid` claim would make the pipeline reject this as a media token.
      expect('jid' in payload!).toBe(false);
      // The raw provider token is still handed over during the transition.
      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
    });

    it('caches the resolved account UUID for a Supabase outage', async () => {
      await putAuthorizationState(oauthState('cache'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('cache')}`);
      await worker.fetch(request, env);

      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBe(ACCOUNT_UUID);
    });

    it('keeps logging in with no session token when JWT_SECRET is not configured', async () => {
      await putAuthorizationState(oauthState('no-secret'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('no-secret')}`);
      const response = await worker.fetch(request, { ...env, JWT_SECRET: undefined });

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('error')).toBeNull();
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);
      expect(redirectURL.searchParams.get('access_token')).toBe('mock-access-token');
    });

    it('accepts a legacy state that holds the bare redirect URI', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(oauthState('legacy'), 'https://app.example.com/callback');

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow());

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('legacy')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://app.example.com');
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);
    });

    it('logs a known account in from the KV cache when Supabase is unreachable', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/facebook/${FACEBOOK_USER_ID}`, ACCOUNT_UUID);
      await putAuthorizationState(oauthState('outage'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabaseOutage();

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('outage')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://app.example.com');
      expect(redirectURL.searchParams.get('error')).toBeNull();
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);

      const payload = await verifyJWT(redirectURL.searchParams.get('session_token')!, JWT_SECRET);
      expect(payload!.sub).toBe(ACCOUNT_UUID);
    });

    it('fails closed for an unknown account when Supabase is unreachable', async () => {
      await putAuthorizationState(oauthState('fail-closed'), { redirectURI: 'https://app.example.com/callback' });

      interceptTokenExchange();
      interceptUserInfo();
      interceptSupabaseOutage();

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('fail-closed')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=account_unavailable');

      // No identity is invented: no uuid and no session token.
      const redirectURL = new URL(location);
      expect(redirectURL.searchParams.has('uuid')).toBe(false);
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
    });
  });

  describe('link callback', () => {
    it('stashes the provider identity under a link code and links nothing', async () => {
      await putLinkTicket('link-ok');
      await putAuthorizationState(oauthState('link'), {
        redirectURI: 'https://app.example.com/settings',
        linkTicket: 'link-ok',
      });

      // Only the provider calls are intercepted. Any Supabase call the callback
      // made would hit the disabled network and fail the test — which is the
      // point: the callback must not link, because it cannot tell whose browser
      // it is answering.
      interceptTokenExchange();
      interceptUserInfo();

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('link')}`);
      const response = await worker.fetch(request, env);

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin + redirectURL.pathname).toBe('https://app.example.com/settings');
      expect(redirectURL.searchParams.get('provider')).toBe('facebook');

      const linkCode = redirectURL.searchParams.get('link_code')!;
      expect(linkCode).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse((await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`link-code/${linkCode}`))!)).toEqual({
        uuid: ACCOUNT_UUID,
        provider: 'facebook',
        identifier: FACEBOOK_USER_ID,
        nonce: LINK_NONCE,
      });

      // Nothing that could act as a credential travels in this URL, and the
      // nonce stays in the initiating browser.
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
      expect(redirectURL.searchParams.has('user')).toBe(false);
      expect(redirectURL.searchParams.has('uuid')).toBe(false);
      expect(response.headers.get('Location')).not.toContain(LINK_NONCE);

      // No link, so no account row and no outage-cache entry yet either.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBeNull();
      // The ticket is single use.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('link-ticket/link-ok')).toBeNull();
    });

    it('reports expired and stashes nothing for an unknown, replayed or timed-out ticket', async () => {
      await putAuthorizationState(oauthState('expired'), {
        redirectURI: 'https://app.example.com/settings',
        linkTicket: 'never-issued',
      });

      interceptTokenExchange();
      interceptUserInfo();

      const request = new Request(`${WORKER_URL}/callback?code=test-code&state=${oauthState('expired')}`);
      const response = await worker.fetch(request, env);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('link_result')).toBe('expired');
      expect(redirectURL.searchParams.has('link_code')).toBe(false);

      const stashed = await env.AUDIO_UNDERVIEW_OAUTH_STATE.list({ prefix: 'link-code/' });
      expect(stashed.keys).toEqual([]);
    });
  });

  describe('POST /accounts/link-confirm', () => {
    function interceptProviderRoundTrip() {
      interceptTokenExchange();
      interceptUserInfo();
    }

    function interceptLinkInsert() {
      interceptAccountMissing();
      interceptSupabase('GET', 'users', 200, { uuid: ACCOUNT_UUID });
      interceptSupabase('POST', 'accounts', 201, facebookAccountRow());
    }

    it('links when the same browser returns with both halves', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('confirm'));
      interceptLinkInsert();

      const response = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: 'linked' });
      // Only now does the account become resolvable during a Supabase outage.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBe(ACCOUNT_UUID);
    });

    it('answers 409 when the provider belongs to another account', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('confconflict'));
      interceptSupabase('GET', 'accounts', 200, facebookAccountRow(OTHER_ACCOUNT_UUID));

      const response = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ result: 'conflict' });
      // A conflict must not point the outage cache at the wrong account.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBeNull();
    });

    it('refuses the cross-browser attack the callback can no longer decide (link CSRF)', async () => {
      // The attacker mints a ticket for their own account and calls /authorize
      // server side; the victim's browser finishes the round trip and gets the
      // link code, while the nonce never left the attacker.
      interceptProviderRoundTrip();
      const attacker = await startLinkFlow(oauthState('csrf'), ACCOUNT_UUID);
      const victimToken = await createSessionToken(OTHER_ACCOUNT_UUID);

      // Victim's browser: holds the code, never saw the nonce.
      const victimAttempt = await worker.fetch(
        linkConfirmRequest(victimToken, { link_code: attacker.linkCode }),
        env,
      );
      // Attacker: holds the nonce and the matching session, but no link code.
      const attackerAttempt = await worker.fetch(
        linkConfirmRequest(attacker.token, { nonce: attacker.nonce }),
        env,
      );

      expect(victimAttempt.status).toBe(403);
      expect(await victimAttempt.json()).toMatchObject({ error: 'link_binding_failed' });
      expect(attackerAttempt.status).toBe(410);
      expect(await attackerAttempt.json()).toMatchObject({ error: 'link_code_expired' });

      // Zero links: no Supabase interceptors were registered, so any attempt to
      // write would have failed the test outright.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBeNull();
    });

    it('refuses a link code confirmed under a different session', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('reverse'));
      const otherToken = await createSessionToken(OTHER_ACCOUNT_UUID);

      const response = await worker.fetch(
        linkConfirmRequest(otherToken, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'link_binding_failed' });
    });

    it('refuses a mismatched nonce and burns the code', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('badnonce'));

      const guessed = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: crypto.randomUUID() }),
        env,
      );
      const retry = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(guessed.status).toBe(403);
      expect(retry.status).toBe(410);
    });

    it('answers 410 for a replayed link code', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('replay'));
      interceptLinkInsert();

      const first = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );
      const second = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(410);
    });

    it('answers 410 for a body that carries no usable link code', async () => {
      const token = await createSessionToken();

      for (const body of [{}, { nonce: LINK_NONCE }, { link_code: 42, nonce: LINK_NONCE }]) {
        const response = await worker.fetch(linkConfirmRequest(token, body), env);
        expect(response.status).toBe(410);
      }
    });

    it('returns 401 without a session token, leaving the code unspent', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('unauth'));

      const response = await worker.fetch(
        new Request(`${WORKER_URL}/accounts/link-confirm`, {
          method: 'POST',
          headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' },
          body: JSON.stringify({ link_code: flow.linkCode, nonce: flow.nonce }),
        }),
        env,
      );

      expect(response.status).toBe(401);
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`link-code/${flow.linkCode}`)).not.toBeNull();
    });

    it('returns 503 when Supabase is unreachable', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('confoutage'));
      interceptSupabaseOutage();

      const response = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        env,
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'accounts_unavailable' });
    });
  });

  describe('POST /link-tickets', () => {
    it('mints a ticket bound to the session sub, plus a nonce for the browser', async () => {
      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', token), env);

      expect(response.status).toBe(200);
      const body = await response.json() as { ticket: string; nonce: string };
      expect(body.ticket).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.nonce).not.toBe(body.ticket);

      const stored = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`link-ticket/${body.ticket}`);
      expect(JSON.parse(stored!)).toEqual({ uuid: ACCOUNT_UUID, nonce: body.nonce });
    });

    it('binds the ticket to the token sub, never to a caller supplied uuid', async () => {
      const token = await createSessionToken();
      const request = new Request(`${WORKER_URL}/link-tickets?uuid=${OTHER_ACCOUNT_UUID}`, {
        method: 'POST',
        headers: { Origin: 'https://example.com', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ uuid: OTHER_ACCOUNT_UUID }),
      });

      const response = await worker.fetch(request, env);
      const body = await response.json() as { ticket: string };
      const stored = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`link-ticket/${body.ticket}`);

      expect(stored).toContain(ACCOUNT_UUID);
      expect(stored).not.toContain(OTHER_ACCOUNT_UUID);
    });

    it('returns 401 without a session token', async () => {
      const request = new Request(`${WORKER_URL}/link-tickets`, {
        method: 'POST',
        headers: { Origin: 'https://example.com' },
      });

      const response = await worker.fetch(request, env);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('returns 401 for a media token that carries jid', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const mediaToken = await signJWT(
        { sub: ACCOUNT_UUID, jid: 'job-1', iat: issuedAt, exp: issuedAt + 300 },
        JWT_SECRET,
      );

      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', mediaToken), env);
      expect(response.status).toBe(401);
    });

    it('returns 401 for a token signed with the wrong secret', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const forged = await signJWT(
        { sub: ACCOUNT_UUID, iat: issuedAt, exp: issuedAt + 300 },
        'not-the-real-secret',
      );

      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', forged), env);
      expect(response.status).toBe(401);
    });

    it('returns 503 when JWT_SECRET is not configured', async () => {
      const token = await createSessionToken();
      const response = await worker.fetch(
        authorizedRequest('/link-tickets', 'POST', token),
        { ...env, JWT_SECRET: undefined },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'session_tokens_unavailable' });
    });
  });

  describe('GET /accounts', () => {
    it('lists linked providers without the provider-side identifier', async () => {
      interceptSupabase('GET', 'accounts', 200, [googleAccountRow(), facebookAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts', 'GET', token), env);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        accounts: [
          { provider: 'facebook', linkedAt: '2026-01-01T00:00:00.000Z' },
          { provider: 'google', linkedAt: '2026-08-01T00:00:00.000Z' },
        ],
      });
      expect(body).not.toContain('google-sub-1');
      expect(body).not.toContain(FACEBOOK_USER_ID);
    });

    it('returns 401 without a session token', async () => {
      const request = new Request(`${WORKER_URL}/accounts`, { headers: { Origin: 'https://example.com' } });
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(401);
    });

    it('returns 503 when JWT_SECRET is not configured', async () => {
      const token = await createSessionToken();
      const response = await worker.fetch(
        authorizedRequest('/accounts', 'GET', token),
        { ...env, JWT_SECRET: undefined },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'session_tokens_unavailable' });
    });

    it('returns 503 when Supabase is unreachable', async () => {
      interceptSupabaseOutage();

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts', 'GET', token), env);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'accounts_unavailable' });
    });
  });

  describe('DELETE /accounts/{provider}', () => {
    it('removes a provider while another login remains', async () => {
      interceptSupabase('GET', 'accounts', 200, [facebookAccountRow(), googleAccountRow()]);
      interceptSupabase('DELETE', 'accounts', 200, [googleAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/google', 'DELETE', token), env);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removed: true });
    });

    it('drops the account cache entry so the removed login cannot come back', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/facebook/${FACEBOOK_USER_ID}`, ACCOUNT_UUID);
      interceptSupabase('GET', 'accounts', 200, [facebookAccountRow(), googleAccountRow()]);
      interceptSupabase('DELETE', 'accounts', 200, [facebookAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/facebook', 'DELETE', token), env);

      expect(response.status).toBe(200);
      // Otherwise the disconnected Facebook account still resolves to this UUID
      // through the Supabase-outage fallback — a login that was never revoked.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBeNull();
    });

    it('refuses to remove the last remaining login', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/facebook/${FACEBOOK_USER_ID}`, ACCOUNT_UUID);
      interceptSupabase('GET', 'accounts', 200, [facebookAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/facebook', 'DELETE', token), env);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'last_account' });
      // A refused removal leaves the cached login alone.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/facebook/${FACEBOOK_USER_ID}`)).toBe(ACCOUNT_UUID);
    });

    it('returns 404 for a provider that is not linked', async () => {
      interceptSupabase('GET', 'accounts', 200, [facebookAccountRow(), googleAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/naver', 'DELETE', token), env);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'account_not_found' });
    });

    it('returns 401 without a session token', async () => {
      const request = new Request(`${WORKER_URL}/accounts/facebook`, {
        method: 'DELETE',
        headers: { Origin: 'https://example.com' },
      });

      const response = await worker.fetch(request, env);
      expect(response.status).toBe(401);
    });
  });

  describe('CORS preflight', () => {
    it('allows Authorization and DELETE for an allowed origin', async () => {
      const request = new Request(`${WORKER_URL}/accounts`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
      expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, DELETE, OPTIONS');
      expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type');
    });

    it('does not answer with CORS headers for an unknown origin', async () => {
      const request = new Request(`${WORKER_URL}/accounts`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://attacker.example.net' },
      });

      const response = await worker.fetch(request, env);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });
  });

  describe('Axiom instrumentation', () => {
    it('wraps the handler with this worker service name and dataset', () => {
      const instrumentWorkerMock = vi.mocked(instrumentWorker);
      expect(instrumentWorkerMock).toHaveBeenCalledTimes(1);

      const [, resolveConfiguration] = instrumentWorkerMock.mock.calls[0]!;
      expect(resolveConfiguration({
        AXIOM_API_TOKEN: 'test-axiom-token',
        AXIOM_DATASET: 'test-dataset',
      } as never)).toEqual({
        token: 'test-axiom-token',
        dataset: 'test-dataset',
        serviceName: 'facebook-oauth-provider-worker',
      });
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
