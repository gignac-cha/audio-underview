import { describe, expect, it, vi } from 'vitest';
import {
  createAuthorizationCode,
  createOAuthState,
  issueRefreshToken,
} from '@audio-underview/authentication-core';
import type { AuthenticatedUser } from '@audio-underview/schemas';
import { verifyJWT } from '@audio-underview/worker-foundation';
import { createAuthenticationRouter } from '../sources/application.ts';
import type { WorkerEnvironment } from '../sources/environment.ts';

/** 테스트용 in-memory KVNamespace */
const createFakeKV = (): KVNamespace => {
  const entries = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(entries.get(key) ?? null),
    put: (key: string, value: string) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      entries.delete(key);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
};

const JWT_SECRET = 'authentication-test-secret';
const USER_UUID = '00000000-0000-4000-8000-000000000009';
const FRONTEND = 'https://app.example.com';

const createEnvironment = (kv: KVNamespace): WorkerEnvironment => ({
  ALLOWED_ORIGINS: FRONTEND,
  FRONTEND_URL: FRONTEND,
  JWT_SECRET,
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SECRET_KEY: 'service-key',
  OAUTH_STATE: kv,
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  X_CLIENT_ID: 'x-client',
  X_CLIENT_SECRET: 'x-secret',
});

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

const testUser: AuthenticatedUser = {
  id: '12345',
  email: 'user@example.com',
  name: 'Test User',
  provider: 'github',
  uuid: USER_UUID,
};

describe('GET /providers', () => {
  it('lists only providers with configured credentials', async () => {
    const router = createAuthenticationRouter();
    const response = await router.fetch(
      new Request('https://auth.example.com/providers'),
      createEnvironment(createFakeKV()),
      executionContext,
    );
    expect(await response.json()).toEqual({ providers: ['github', 'x'] });
  });
});

describe('GET /providers/:provider/authorize', () => {
  const authorize = (environment: WorkerEnvironment, provider: string, query = '') =>
    createAuthenticationRouter().fetch(
      new Request(`https://auth.example.com/providers/${provider}/authorize${query}`),
      environment,
      executionContext,
    );

  it('redirects to the provider with state and stores the state record', async () => {
    const kv = createFakeKV();
    const response = await authorize(
      createEnvironment(kv),
      'github',
      `?redirect_uri=${encodeURIComponent(`${FRONTEND}/authentication/callback`)}`,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.origin).toBe('https://github.com');
    expect(location.searchParams.get('client_id')).toBe('github-client');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://auth.example.com/providers/github/callback',
    );
    const state = location.searchParams.get('state');
    expect(state).not.toBeNull();
    expect(await kv.get(`state:github:${state ?? ''}`)).not.toBeNull();
  });

  it('carries a PKCE challenge for x and stores the verifier', async () => {
    const kv = createFakeKV();
    const response = await authorize(
      createEnvironment(kv),
      'x',
      `?redirect_uri=${encodeURIComponent(`${FRONTEND}/authentication/callback`)}`,
    );
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.searchParams.get('code_challenge')).not.toBeNull();
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');

    const state = location.searchParams.get('state') ?? '';
    const stored = JSON.parse((await kv.get(`state:x:${state}`)) ?? '{}') as {
      codeVerifier?: string;
    };
    expect(stored.codeVerifier).toBeDefined();
  });

  it('returns 404 for unknown or disabled providers', async () => {
    const environment = createEnvironment(createFakeKV());
    expect((await authorize(environment, 'unknownname', '?redirect_uri=https://a.com')).status).toBe(404);
    expect(
      (await authorize(environment, 'google', `?redirect_uri=${FRONTEND}/x`)).status,
    ).toBe(404); // 자격 증명 미설정
  });

  it('rejects redirect_uri with a disallowed origin (open-redirect 방지)', async () => {
    const response = await authorize(
      createEnvironment(createFakeKV()),
      'github',
      '?redirect_uri=https://evil.example.com/callback',
    );
    expect(response.status).toBe(400);
  });

  it('rejects a missing redirect_uri', async () => {
    const response = await authorize(createEnvironment(createFakeKV()), 'github');
    expect(response.status).toBe(400);
  });
});

describe('GET /providers/:provider/callback', () => {
  it('completes the flow: token exchange → user fetch → social login → one-time code redirect', async () => {
    const kv = createFakeKV();
    const environment = createEnvironment(kv);
    const redirectURI = `${FRONTEND}/authentication/callback`;
    const state = await createOAuthState(kv, { provider: 'github', redirectURI });

    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.includes('github.com/login/oauth/access_token')) {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'gh-token', token_type: 'bearer' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url.includes('api.github.com/user')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 12345,
              login: 'tester',
              name: 'Test User',
              email: 'user@example.com',
              avatar_url: 'https://avatars.example.com/1',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const socialLogin = vi
      .fn()
      .mockResolvedValue({ userUUID: USER_UUID, isNewUser: true, isNewAccount: true });

    const router = createAuthenticationRouter({
      fetchImplementation: fetchMock as typeof fetch,
      socialLogin,
    });
    const response = await router.fetch(
      new Request(
        `https://auth.example.com/providers/github/callback?code=provider-code&state=${state}`,
      ),
      environment,
      executionContext,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(redirectURI);
    expect(location.searchParams.get('provider')).toBe('github');
    // redirect에는 일회용 code만 — 토큰/사용자 정보 없음 (스펙 §10.2 해소)
    expect(location.searchParams.get('access_token')).toBeNull();
    expect(location.searchParams.get('user')).toBeNull();
    const code = location.searchParams.get('code');
    expect(code).not.toBeNull();
    expect(await kv.get(`authorization-code:${code ?? ''}`)).not.toBeNull();

    expect(socialLogin).toHaveBeenCalledWith({ provider: 'github', identifier: '12345' });
  });

  it('redirects with invalid_state when the state is unknown', async () => {
    const router = createAuthenticationRouter();
    const response = await router.fetch(
      new Request('https://auth.example.com/providers/github/callback?code=x&state=unknown'),
      createEnvironment(createFakeKV()),
      executionContext,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_state');
  });

  it('state is single-use (재사용 시 invalid_state)', async () => {
    const kv = createFakeKV();
    const environment = createEnvironment(kv);
    const state = await createOAuthState(kv, {
      provider: 'github',
      redirectURI: `${FRONTEND}/authentication/callback`,
    });
    const failingFetch = (() => Promise.reject(new Error('network'))) as typeof fetch;
    const router = createAuthenticationRouter({ fetchImplementation: failingFetch });
    const call = () =>
      router.fetch(
        new Request(`https://auth.example.com/providers/github/callback?code=x&state=${state}`),
        environment,
        executionContext,
      );

    await call(); // 첫 호출이 state를 소비 (교환 실패와 무관)
    const second = await call();
    const location = new URL(second.headers.get('Location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_state');
  });

  it('redirects provider errors to the frontend', async () => {
    const router = createAuthenticationRouter();
    const response = await router.fetch(
      new Request('https://auth.example.com/providers/github/callback?error=access_denied'),
      createEnvironment(createFakeKV()),
      executionContext,
    );
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
  });
});

describe('POST /tokens', () => {
  const postTokens = (environment: WorkerEnvironment, body: unknown) =>
    createAuthenticationRouter().fetch(
      new Request('https://auth.example.com/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      environment,
      executionContext,
    );

  it('exchanges a one-time authorization code for a token pair', async () => {
    const kv = createFakeKV();
    const environment = createEnvironment(kv);
    const code = await createAuthorizationCode(kv, { user: testUser });

    const response = await postTokens(environment, {
      grant_type: 'authorization_code',
      code,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      user: AuthenticatedUser;
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.user).toEqual(testUser);

    const payload = await verifyJWT(body.access_token, JWT_SECRET);
    expect(payload?.sub).toBe(USER_UUID);

    // code는 일회용
    const replay = await postTokens(environment, { grant_type: 'authorization_code', code });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const kv = createFakeKV();
    const environment = createEnvironment(kv);
    const firstRefreshToken = await issueRefreshToken(kv, testUser);

    const rotated = await postTokens(environment, {
      grant_type: 'refresh_token',
      refresh_token: firstRefreshToken,
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { refresh_token: string };
    expect(rotatedBody.refresh_token).not.toBe(firstRefreshToken);

    // 소비된 토큰 재사용 → 계열 폐기
    const reuse = await postTokens(environment, {
      grant_type: 'refresh_token',
      refresh_token: firstRefreshToken,
    });
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({
      error_description: expect.stringContaining('reuse detected') as string,
    });

    // 폐기된 계열의 새 토큰도 무효
    const revoked = await postTokens(environment, {
      grant_type: 'refresh_token',
      refresh_token: rotatedBody.refresh_token,
    });
    expect(revoked.status).toBe(400);
  });

  it('rejects unknown grant types (400)', async () => {
    const response = await postTokens(createEnvironment(createFakeKV()), {
      grant_type: 'password',
      username: 'a',
    });
    expect(response.status).toBe(400);
  });
});
