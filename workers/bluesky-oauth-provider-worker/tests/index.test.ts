import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@audio-underview/axiom-logger', () => ({
  instrumentWorker: vi.fn((handler: unknown) => handler),
}));

import { env, fetchMock } from 'cloudflare:test';
import { signJWT, verifyJWT } from '@audio-underview/worker-tools';
import worker from '../sources/index.ts';

const WORKER_URL = 'https://worker.example.com';
const CLIENT_ID = `${WORKER_URL}/oauth-client-metadata.json`;
const CALLBACK_URL = `${WORKER_URL}/callback`;
const SUPABASE_ORIGIN = 'https://test.supabase.co';
const JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
const ACCOUNT_UUID = '83156cb5-c92a-4c75-b944-341d2d857bbf';
const OTHER_ACCOUNT_UUID = '11111111-2222-3333-4444-555555555555';

const HANDLE = 'alice.bsky.social';
const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const OTHER_DID = 'did:plc:zyxwvutsrqponmlkjihgfedc';
const APPVIEW_ORIGIN = 'https://public.api.bsky.app';
const PLC_ORIGIN = 'https://plc.directory';
const PDS_ORIGIN = 'https://pds.example.com';
const ISSUER = 'https://entryway.example.com';
const WEB_DID_ORIGIN = 'https://alice.example.com';

const CLIENT_KEY_ID = 'test-client-key';
const REQUEST_URI = 'urn:ietf:params:oauth:request_uri:test-request';
const ACCESS_TOKEN = 'test-bluesky-access-token';
const CODE_VERIFIER = 'test-code-verifier-0123456789abcdefghijklmnopqrstuvwxyz';
const AUTHORIZATION_SERVER_NONCE = 'test-nonce-authorization-server';
const TOKEN_ENDPOINT_NONCE = 'test-nonce-token-endpoint';
const PDS_NONCE = 'test-nonce-pds';

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Client key the operator would put in BLUESKY_CLIENT_PRIVATE_JWK. */
let clientPrivateJWK: JsonWebKey & { kid: string };
let clientPublicKey: CryptoKey;
/** DPoP key of the login the callback tests resume. */
let dpopPrivateJWK: { kty: string; crv: string; x: string; y: string; d: string };
let dpopPublicKey: CryptoKey;
/**
 * The miniflare bindings carry a placeholder for BLUESKY_CLIENT_PRIVATE_JWK
 * (no real key goes into the configuration), so every test that needs a working client
 * key runs against this copy with a key generated for the test run.
 */
let environment: typeof env;

beforeAll(async () => {
  const clientKeyPair = (await crypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exportedClientKey = (await crypto.subtle.exportKey('jwk', clientKeyPair.privateKey)) as JsonWebKey;
  // Shaped like the output of the key generation command in the design
  // document: WebCrypto's own members plus kid, alg and use.
  clientPrivateJWK = { ...exportedClientKey, kid: CLIENT_KEY_ID, alg: 'ES256', use: 'sig' };
  clientPublicKey = clientKeyPair.publicKey;

  const dpopKeyPair = (await crypto.subtle.generateKey(ECDSA_P256, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exportedDPoPKey = (await crypto.subtle.exportKey('jwk', dpopKeyPair.privateKey)) as JsonWebKey;
  dpopPrivateJWK = { kty: 'EC', crv: 'P-256', x: exportedDPoPKey.x!, y: exportedDPoPKey.y!, d: exportedDPoPKey.d! };
  dpopPublicKey = dpopKeyPair.publicKey;

  environment = { ...env, BLUESKY_CLIENT_PRIVATE_JWK: JSON.stringify(clientPrivateJWK) };
});

function decodeBase64URL(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function encodeBase64URL(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Base64URL(value: string): Promise<string> {
  return encodeBase64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value))));
}

interface DecodedJWT {
  header: Record<string, any>;
  payload: Record<string, any>;
}

function decodeJWT(token: string): DecodedJWT {
  const [header, payload] = token.split('.');
  return {
    header: JSON.parse(textDecoder.decode(decodeBase64URL(header))),
    payload: JSON.parse(textDecoder.decode(decodeBase64URL(payload))),
  };
}

async function isSignedBy(token: string, publicKey: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = token.split('.');
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    decodeBase64URL(signature),
    textEncoder.encode(`${header}.${payload}`),
  );
}

async function importVerificationKey(jwk: { x: string; y: string }): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDSA_P256, true, ['verify']);
}

/** What the fetch mock saw of an outbound request. */
interface CapturedRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function capture(target: CapturedRequest[] | undefined, options: any) {
  target?.push({
    path: options.path,
    method: options.method,
    headers: options.headers ?? {},
    body: typeof options.body === 'string' ? options.body : '',
  });
}

function blueskyAccountRow(uuid: string = ACCOUNT_UUID) {
  return { provider: 'bluesky', identifier: DID, uuid, created_at: '2026-01-01T00:00:00+00:00' };
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

function interceptResolveHandle(did: string = DID) {
  fetchMock
    .get(APPVIEW_ORIGIN)
    .intercept({ path: /^\/xrpc\/com\.atproto\.identity\.resolveHandle\?handle=/, method: 'GET' })
    .reply(200, JSON.stringify({ did }));
}

function didDocument(overrides: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: DID,
    alsoKnownAs: [`at://${HANDLE}`],
    verificationMethod: [],
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS_ORIGIN }],
    ...overrides,
  };
}

function interceptDIDDocument(document: Record<string, unknown> = didDocument()) {
  fetchMock
    .get(PLC_ORIGIN)
    .intercept({ path: `/${DID}`, method: 'GET' })
    .reply(200, JSON.stringify(document));
}

function interceptProtectedResourceMetadata(pdsOrigin: string = PDS_ORIGIN) {
  fetchMock
    .get(pdsOrigin)
    .intercept({ path: '/.well-known/oauth-protected-resource', method: 'GET' })
    .reply(200, JSON.stringify({ resource: pdsOrigin, authorization_servers: [ISSUER] }));
}

function authorizationServerMetadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
    require_pushed_authorization_requests: true,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256'],
    scopes_supported: ['atproto', 'transition:email', 'transition:generic'],
    authorization_response_iss_parameter_supported: true,
    dpop_signing_alg_values_supported: ['ES256'],
    client_id_metadata_document_supported: true,
    ...overrides,
  };
}

function interceptAuthorizationServerMetadata(metadata: Record<string, unknown> = authorizationServerMetadata()) {
  fetchMock
    .get(ISSUER)
    .intercept({ path: '/.well-known/oauth-authorization-server', method: 'GET' })
    .reply(200, JSON.stringify(metadata));
}

function interceptPushedAuthorizationRequest(captured?: CapturedRequest[], nonce: string = AUTHORIZATION_SERVER_NONCE) {
  fetchMock
    .get(ISSUER)
    .intercept({ path: '/oauth/par', method: 'POST' })
    .reply(201, (options: any) => {
      capture(captured, options);
      return JSON.stringify({ request_uri: REQUEST_URI, expires_in: 299 });
    }, { headers: { 'DPoP-Nonce': nonce } });
}

/** The authorization server's "send that again with my nonce" answer. */
function interceptUseDPoPNonce(path: string, nonce: string, captured?: CapturedRequest[]) {
  fetchMock
    .get(ISSUER)
    .intercept({ path, method: 'POST' })
    .reply(400, (options: any) => {
      capture(captured, options);
      return JSON.stringify({ error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' });
    }, { headers: { 'DPoP-Nonce': nonce } });
}

/** Everything `/authorize` talks to, from the handle to the PAR endpoint. */
function interceptLoginStart(captured?: CapturedRequest[]) {
  interceptResolveHandle();
  interceptDIDDocument();
  interceptProtectedResourceMetadata();
  interceptAuthorizationServerMetadata();
  interceptPushedAuthorizationRequest(captured);
}

function interceptTokenExchange(captured?: CapturedRequest[], overrides: Record<string, unknown> = {}) {
  fetchMock
    .get(ISSUER)
    .intercept({ path: '/oauth/token', method: 'POST' })
    .reply(200, (options: any) => {
      capture(captured, options);
      return JSON.stringify({
        access_token: ACCESS_TOKEN,
        token_type: 'DPoP',
        sub: DID,
        scope: 'atproto transition:email',
        expires_in: 300,
        refresh_token: 'test-bluesky-refresh-token',
        ...overrides,
      });
    }, { headers: { 'DPoP-Nonce': TOKEN_ENDPOINT_NONCE } });
}

function interceptGetSession(captured?: CapturedRequest[], overrides: Record<string, unknown> = {}) {
  fetchMock
    .get(PDS_ORIGIN)
    .intercept({ path: '/xrpc/com.atproto.server.getSession', method: 'GET' })
    .reply(200, (options: any) => {
      capture(captured, options);
      return JSON.stringify({
        did: DID,
        handle: HANDLE,
        email: 'alice@example.com',
        emailConfirmed: true,
        active: true,
        ...overrides,
      });
    }, { headers: { 'DPoP-Nonce': PDS_NONCE } });
}

/** The token half of the callback: authorization server metadata + token. */
function interceptTokenRoundTrip(captured?: CapturedRequest[]) {
  interceptAuthorizationServerMetadata();
  interceptTokenExchange(captured);
}

/** Everything a login callback talks to. */
function interceptLoginCompletion() {
  interceptTokenRoundTrip();
  interceptGetSession();
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

interface StoredAuthorizationState {
  redirectURI: string;
  linkTicket?: string;
  codeVerifier: string;
  dpopPrivateJWK: typeof dpopPrivateJWK;
  did: string;
  pdsURL: string;
  issuer: string;
  dpopNonce?: string;
}

/** Writes the state `/authorize` would have left behind for this login. */
async function putAuthorizationState(
  state: string,
  overrides: Partial<StoredAuthorizationState> = {},
) {
  const value: StoredAuthorizationState = {
    redirectURI: 'https://app.example.com/callback',
    codeVerifier: CODE_VERIFIER,
    dpopPrivateJWK,
    did: DID,
    pdsURL: PDS_ORIGIN,
    issuer: ISSUER,
    dpopNonce: AUTHORIZATION_SERVER_NONCE,
    ...overrides,
  };
  await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(state, JSON.stringify(value));
}

/** Reads back the one OAuth state `/authorize` stored. */
async function readStoredState(): Promise<{ key: string; value: Record<string, any> }> {
  const { keys } = await env.AUDIO_UNDERVIEW_OAUTH_STATE.list();
  const stateKeys = keys.map((key: { name: string }) => key.name).filter((name: string) => /^[A-Za-z0-9]{32}$/.test(name));
  expect(stateKeys).toHaveLength(1);
  return {
    key: stateKeys[0],
    value: JSON.parse((await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(stateKeys[0]))!),
  };
}

function authorizeRequest(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`${WORKER_URL}/authorize?${query}`, { headers });
}

function callbackRequest(state: string, options: { code?: string; issuer?: string | null } = {}): Request {
  const url = new URL(`${WORKER_URL}/callback`);
  url.searchParams.set('code', options.code ?? 'test-code');
  url.searchParams.set('state', state);
  if (options.issuer !== null) {
    url.searchParams.set('iss', options.issuer ?? ISSUER);
  }
  return new Request(url.toString());
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
  return signJWT({ sub: subject, provider: 'bluesky', iat: issuedAt, exp: issuedAt + 86_400 }, JWT_SECRET);
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
  const ticketResponse = await worker.fetch(authorizedRequest('/link-tickets', 'POST', token), environment);
  const { ticket, nonce } = await ticketResponse.json() as { ticket: string; nonce: string };

  await putAuthorizationState(state, {
    redirectURI: 'https://app.example.com/settings',
    linkTicket: ticket,
  });

  const callbackResponse = await worker.fetch(callbackRequest(state), environment);
  const redirectURL = new URL(callbackResponse.headers.get('Location')!);

  return { token, nonce, redirectURL, linkCode: redirectURL.searchParams.get('link_code') };
}

/** Origins that get intercepted; their mocks are reset between tests. */
const MOCK_ORIGINS = [SUPABASE_ORIGIN, APPVIEW_ORIGIN, PLC_ORIGIN, PDS_ORIGIN, ISSUER, WEB_DID_ORIGIN];

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

describe('bluesky-oauth-provider-worker', () => {
  describe('client metadata', () => {
    it('serves the client metadata document with every field atproto requires', async () => {
      const response = await worker.fetch(new Request(CLIENT_ID), environment);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toEqual({
        // The client id is the URL the document is served from.
        client_id: CLIENT_ID,
        client_name: 'Audio Underview',
        redirect_uris: [CALLBACK_URL],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: 'atproto transition:email',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true,
        application_type: 'web',
        jwks_uri: `${WORKER_URL}/jwks.json`,
      });
    });

    it('publishes the public client key without its private part', async () => {
      const response = await worker.fetch(new Request(`${WORKER_URL}/jwks.json`), environment);

      expect(response.status).toBe(200);
      const body = await response.json() as { keys: Record<string, unknown>[] };
      expect(body.keys).toEqual([{
        kty: 'EC',
        crv: 'P-256',
        x: clientPrivateJWK.x,
        y: clientPrivateJWK.y,
        kid: CLIENT_KEY_ID,
        alg: 'ES256',
        use: 'sig',
      }]);
      expect(JSON.stringify(body)).not.toContain(clientPrivateJWK.d!);
    });

    it('answers 503 for the key set when the client key is not configured', async () => {
      // The miniflare binding holds a placeholder, not a JWK.
      const response = await worker.fetch(new Request(`${WORKER_URL}/jwks.json`), env);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'client_key_unavailable' });
    });
  });

  describe('handleAuthorize', () => {
    it('returns 400 when redirect_uri is missing', async () => {
      const response = await worker.fetch(authorizeRequest(`handle=${HANDLE}`), environment);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain('Missing redirect_uri');
    });

    it('returns 400 when handle is missing', async () => {
      // No interceptors: without a handle there is no server to talk to.
      const response = await worker.fetch(
        authorizeRequest('redirect_uri=https://app.example.com/callback'),
        environment,
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Missing handle');
    });

    it('returns 400 for a value that is not a handle', async () => {
      for (const handle of ['alice', 'did:plc:abcdefghijklmnopqrstuvwx', 'alice.bsky.social/../x', 'handle.invalid']) {
        const response = await worker.fetch(
          authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${encodeURIComponent(handle)}`),
          environment,
        );

        expect(response.status).toBe(400);
        expect(await response.text()).toContain('Invalid handle');
      }
    });

    it('redirects to the authorization endpoint with only client_id and request_uri', async () => {
      interceptLoginStart();

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin + redirectURL.pathname).toBe(`${ISSUER}/oauth/authorize`);
      expect(redirectURL.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(redirectURL.searchParams.get('request_uri')).toBe(REQUEST_URI);
      // State, PKCE, scope and redirect_uri travelled in the PAR body instead.
      expect([...redirectURL.searchParams.keys()].sort()).toEqual(['client_id', 'request_uri']);
    });

    it('stores state in KV with redirect_uri and the login bindings', async () => {
      interceptLoginStart();

      await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      const { value } = await readStoredState();
      expect(value).toEqual({
        redirectURI: 'https://app.example.com/callback',
        codeVerifier: expect.stringMatching(/^[A-Za-z0-9._~-]{43,128}$/),
        dpopPrivateJWK: {
          kty: 'EC',
          crv: 'P-256',
          x: expect.any(String),
          y: expect.any(String),
          d: expect.any(String),
        },
        did: DID,
        pdsURL: PDS_ORIGIN,
        issuer: ISSUER,
        // The nonce the PAR response carried, for the token request.
        dpopNonce: AUTHORIZATION_SERVER_NONCE,
      });
    });

    it('pushes the authorization request with PKCE, login_hint, DPoP and a client assertion', async () => {
      const pushed: CapturedRequest[] = [];
      interceptLoginStart(pushed);

      await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=@Alice.Bsky.Social`),
        environment,
      );

      expect(pushed).toHaveLength(1);
      const { key: state, value: stored } = await readStoredState();
      const body = new URLSearchParams(pushed[0].body);

      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('response_type')).toBe('code');
      expect(body.get('redirect_uri')).toBe(CALLBACK_URL);
      expect(body.get('scope')).toBe('atproto transition:email');
      expect(body.get('state')).toBe(state);
      expect(body.get('code_challenge_method')).toBe('S256');
      expect(body.get('code_challenge')).toBe(await sha256Base64URL(stored.codeVerifier));
      // The normalized handle the user typed, not the DID.
      expect(body.get('login_hint')).toBe(HANDLE);
      expect(body.has('client_secret')).toBe(false);

      // private_key_jwt: signed by the configured client key, aimed at the issuer.
      expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      const assertion = body.get('client_assertion')!;
      expect(await isSignedBy(assertion, clientPublicKey)).toBe(true);
      const decodedAssertion = decodeJWT(assertion);
      expect(decodedAssertion.header).toEqual({ alg: 'ES256', kid: CLIENT_KEY_ID });
      expect(decodedAssertion.payload).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: ISSUER });
      expect(decodedAssertion.payload.jti).toEqual(expect.any(String));
      expect(decodedAssertion.payload.exp - decodedAssertion.payload.iat).toBe(60);

      // DPoP: signed by the login's own key, whose private half went to the state.
      const proof = pushed[0].headers['dpop'];
      const decodedProof = decodeJWT(proof);
      expect(decodedProof.header).toEqual({
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: { kty: 'EC', crv: 'P-256', x: stored.dpopPrivateJWK.x, y: stored.dpopPrivateJWK.y },
      });
      expect(decodedProof.payload).toMatchObject({ htm: 'POST', htu: `${ISSUER}/oauth/par` });
      expect(decodedProof.payload.nonce).toBeUndefined();
      expect(await isSignedBy(proof, await importVerificationKey(decodedProof.header.jwk))).toBe(true);
    });

    it('retries the pushed authorization request once with the server nonce', async () => {
      const pushed: CapturedRequest[] = [];
      interceptResolveHandle();
      interceptDIDDocument();
      interceptProtectedResourceMetadata();
      interceptAuthorizationServerMetadata();
      interceptUseDPoPNonce('/oauth/par', 'test-nonce-first', pushed);
      interceptPushedAuthorizationRequest(pushed, 'test-nonce-second');

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('Location')!).searchParams.get('request_uri')).toBe(REQUEST_URI);

      expect(pushed).toHaveLength(2);
      expect(decodeJWT(pushed[0].headers['dpop']).payload.nonce).toBeUndefined();
      expect(decodeJWT(pushed[1].headers['dpop']).payload.nonce).toBe('test-nonce-first');
      // A fresh client assertion for the retry: its jti must never repeat.
      const firstAssertion = decodeJWT(new URLSearchParams(pushed[0].body).get('client_assertion')!);
      const secondAssertion = decodeJWT(new URLSearchParams(pushed[1].body).get('client_assertion')!);
      expect(secondAssertion.payload.jti).not.toBe(firstAssertion.payload.jti);

      const { value } = await readStoredState();
      expect(value.dpopNonce).toBe('test-nonce-second');
    });

    it('gives up when the nonce is refused a second time', async () => {
      const pushed: CapturedRequest[] = [];
      interceptResolveHandle();
      interceptDIDDocument();
      interceptProtectedResourceMetadata();
      interceptAuthorizationServerMetadata();
      interceptUseDPoPNonce('/oauth/par', 'test-nonce-first', pushed);
      interceptUseDPoPNonce('/oauth/par', 'test-nonce-second', pushed);

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(pushed).toHaveLength(2);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('authorization_request_failed');
      expect((await env.AUDIO_UNDERVIEW_OAUTH_STATE.list()).keys).toEqual([]);
    });

    it('generates a fresh DPoP key for every login', async () => {
      const pushed: CapturedRequest[] = [];
      interceptLoginStart(pushed);
      interceptLoginStart(pushed);

      for (let attempt = 0; attempt < 2; attempt++) {
        await worker.fetch(
          authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
          environment,
        );
      }

      expect(pushed).toHaveLength(2);
      const firstKey = decodeJWT(pushed[0].headers['dpop']).header.jwk;
      const secondKey = decodeJWT(pushed[1].headers['dpop']).header.jwk;
      expect(secondKey.x).not.toBe(firstKey.x);
    });

    it('resolves a did:web account through its /.well-known/did.json', async () => {
      const webDID = 'did:web:alice.example.com';
      interceptResolveHandle(webDID);
      fetchMock
        .get(WEB_DID_ORIGIN)
        .intercept({ path: '/.well-known/did.json', method: 'GET' })
        .reply(200, JSON.stringify(didDocument({ id: webDID, alsoKnownAs: ['at://alice.example.com'] })));
      interceptProtectedResourceMetadata();
      interceptAuthorizationServerMetadata();
      interceptPushedAuthorizationRequest();

      const response = await worker.fetch(
        authorizeRequest('redirect_uri=https://app.example.com/callback&handle=alice.example.com'),
        environment,
      );

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('Location')!).origin).toBe(ISSUER);
      const { value } = await readStoredState();
      expect(value.did).toBe(webDID);
    });

    it('refuses a handle that its DID document does not claim', async () => {
      const pushed: CapturedRequest[] = [];
      interceptResolveHandle();
      // The resolver points the handle at a DID that names someone else.
      interceptDIDDocument(didDocument({ alsoKnownAs: ['at://mallory.example.com'] }));
      interceptProtectedResourceMetadata();
      interceptAuthorizationServerMetadata();
      interceptPushedAuthorizationRequest(pushed);

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('identity_resolution_failed');
      expect(pushed).toHaveLength(0);
    });

    it('redirects with identity_resolution_failed when the handle does not resolve', async () => {
      fetchMock
        .get(APPVIEW_ORIGIN)
        .intercept({ path: /^\/xrpc\/com\.atproto\.identity\.resolveHandle/, method: 'GET' })
        .reply(400, JSON.stringify({ error: 'InvalidRequest', message: 'Unable to resolve handle' }));

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('identity_resolution_failed');
    });

    it('refuses an authorization server whose metadata names a different issuer', async () => {
      const pushed: CapturedRequest[] = [];
      interceptResolveHandle();
      interceptDIDDocument();
      interceptProtectedResourceMetadata();
      interceptAuthorizationServerMetadata(authorizationServerMetadata({ issuer: 'https://evil.example.net' }));
      interceptPushedAuthorizationRequest(pushed);

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('authorization_server_discovery_failed');
      expect(pushed).toHaveLength(0);
    });

    it('refuses to start before any outbound request when the client key is not configured', async () => {
      // No interceptors: with the network disabled, any lookup would surface
      // as identity_resolution_failed instead.
      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        env,
      );

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('client_key_unavailable');
    });

    it('refuses a redirect_uri that is not an allowed origin', async () => {
      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://evil.example.net/steal&handle=${HANDLE}`),
        environment,
      );

      // The callback would otherwise deliver access_token + session_token there.
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('not an allowed origin');
    });

    it('refuses a redirect_uri that is not an http(s) URL', async () => {
      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=${encodeURIComponent('javascript:alert(1)')}&handle=${HANDLE}`),
        environment,
      );

      expect(response.status).toBe(400);
    });

    it('carries the link ticket through the state so the JWT never enters a URL', async () => {
      const pushed: CapturedRequest[] = [];
      interceptLoginStart(pushed);

      const response = await worker.fetch(
        authorizeRequest(
          `redirect_uri=https://app.example.com/settings&link_ticket=ticket-1&handle=${HANDLE}`,
          { Referer: 'https://app.example.com/settings' },
        ),
        environment,
      );

      const { value } = await readStoredState();
      expect(value.redirectURI).toBe('https://app.example.com/settings');
      expect(value.linkTicket).toBe('ticket-1');
      // The ticket is state, not something the authorization server ever sees.
      expect(response.headers.get('Location')).not.toContain('ticket-1');
      expect(pushed[0].body).not.toContain('ticket-1');
    });

    it('starts a link flow whatever the Referer says, because it proves nothing', async () => {
      // This endpoint is a cookie-less GET, so an attacker sets any Referer
      // they like from their own server. The binding is enforced at
      // POST /accounts/link-confirm instead (see the link CSRF test below).
      for (const headers of [
        { Referer: 'https://evil.example.net/bait' },
        {} as Record<string, string>,
      ]) {
        interceptLoginStart();

        const response = await worker.fetch(
          authorizeRequest(
            `redirect_uri=https://app.example.com/settings&link_ticket=some-ticket&handle=${HANDLE}`,
            headers,
          ),
          environment,
        );

        expect(response.status).toBe(302);
        expect(new URL(response.headers.get('Location')!).origin).toBe(ISSUER);
      }
    });

    it('still allows a plain login with no Referer', async () => {
      interceptLoginStart();

      const response = await worker.fetch(
        authorizeRequest(`redirect_uri=https://app.example.com/callback&handle=${HANDLE}`),
        environment,
      );

      expect(response.status).toBe(302);
    });
  });

  describe('handleCallback', () => {
    it('redirects with error when provider returns error', async () => {
      const request = new Request(
        `${WORKER_URL}/callback?error=access_denied&error_description=User%20denied&iss=${encodeURIComponent(ISSUER)}`,
      );
      const response = await worker.fetch(request, environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=access_denied');
    });

    it('redirects with error when code is missing', async () => {
      const request = new Request(`${WORKER_URL}/callback?state=test-state&iss=${encodeURIComponent(ISSUER)}`);
      const response = await worker.fetch(request, environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_request');
    });

    it('redirects with error when state is invalid', async () => {
      const response = await worker.fetch(callbackRequest('invalid-state'), environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=invalid_state');
    });

    it('redirects with error for a well formed state that is not in KV', async () => {
      const response = await worker.fetch(callbackRequest(oauthState('neverissued')), environment);

      expect(response.headers.get('Location')!).toContain('error=invalid_state');
    });

    it('cannot be used to delete an account cache entry through the state key', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/bluesky/${DID}`, ACCOUNT_UUID);

      const response = await worker.fetch(callbackRequest(`account/bluesky/${DID}`, { code: 'anything' }), environment);

      expect(response.headers.get('Location')!).toContain('error=invalid_state');
      // The state KV namespace also holds the Supabase-outage fallback; an
      // unauthenticated request must not be able to erase it.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBe(ACCOUNT_UUID);
    });

    it('refuses a stored value that is not a Bluesky authorization state', async () => {
      // The bare-redirect-URI format other workers still accept was never
      // written by this worker; without the login bindings nothing can be
      // verified, so it is an invalid state. No interceptors on purpose.
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(oauthState('legacy'), 'https://app.example.com/callback');

      const response = await worker.fetch(callbackRequest(oauthState('legacy')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('invalid_state');
    });

    it('refuses a stored redirect_uri that is not an allowed origin', async () => {
      await putAuthorizationState(oauthState('foreign'), { redirectURI: 'https://evil.example.net/steal' });

      // No interceptors on purpose: the refusal happens before the code is ever
      // exchanged, so any outbound call here would fail the test.
      const response = await worker.fetch(callbackRequest(oauthState('foreign')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('invalid_redirect_uri');
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
    });

    it('refuses a callback whose iss is not the authorization server of the login', async () => {
      await putAuthorizationState(oauthState('mixup'));

      // No interceptors: the code must not reach any token endpoint.
      const response = await worker.fetch(
        callbackRequest(oauthState('mixup'), { issuer: 'https://evil.example.net' }),
        environment,
      );

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('issuer_mismatch');
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      // The state is spent either way.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(oauthState('mixup'))).toBeNull();
    });

    it('refuses a callback that carries no iss', async () => {
      await putAuthorizationState(oauthState('noissuer'));

      const response = await worker.fetch(callbackRequest(oauthState('noissuer'), { issuer: null }), environment);

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('issuer_mismatch');
    });

    it('refuses a token whose sub is not the DID the login resolved', async () => {
      await putAuthorizationState(oauthState('subject'));

      interceptAuthorizationServerMetadata();
      // A malicious or confused authorization server vouching for another account.
      interceptTokenExchange(undefined, { sub: OTHER_DID });
      // No getSession interceptor: nothing after the refusal may run.

      const response = await worker.fetch(callbackRequest(oauthState('subject')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://example.com');
      expect(redirectURL.searchParams.get('error')).toBe('subject_mismatch');
      expect(redirectURL.searchParams.has('uuid')).toBe(false);
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${OTHER_DID}`)).toBeNull();
    });

    it('refuses a session whose DID is not the token subject', async () => {
      await putAuthorizationState(oauthState('sessiondid'));

      interceptTokenRoundTrip();
      interceptGetSession(undefined, { did: OTHER_DID });

      const response = await worker.fetch(callbackRequest(oauthState('sessiondid')), environment);

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('subject_mismatch');
    });

    it('sends the token request with the login DPoP key and nonce, the PKCE verifier and a client assertion', async () => {
      await putAuthorizationState(oauthState('tokenrequest'));

      const tokenRequests: CapturedRequest[] = [];
      interceptTokenRoundTrip(tokenRequests);
      interceptGetSession();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      await worker.fetch(callbackRequest(oauthState('tokenrequest'), { code: 'test-authorization-code' }), environment);

      expect(tokenRequests).toHaveLength(1);
      const body = new URLSearchParams(tokenRequests[0].body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('test-authorization-code');
      expect(body.get('redirect_uri')).toBe(CALLBACK_URL);
      expect(body.get('code_verifier')).toBe(CODE_VERIFIER);
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');

      const assertion = body.get('client_assertion')!;
      expect(await isSignedBy(assertion, clientPublicKey)).toBe(true);
      expect(decodeJWT(assertion).payload).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: ISSUER });

      // Same DPoP key as the PAR, and the nonce the PAR response left behind.
      const proof = tokenRequests[0].headers['dpop'];
      expect(await isSignedBy(proof, dpopPublicKey)).toBe(true);
      const decodedProof = decodeJWT(proof);
      expect(decodedProof.header.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: dpopPrivateJWK.x, y: dpopPrivateJWK.y });
      expect(decodedProof.payload).toMatchObject({
        htm: 'POST',
        htu: `${ISSUER}/oauth/token`,
        nonce: AUTHORIZATION_SERVER_NONCE,
      });
    });

    it('retries the token request once with a rotated nonce', async () => {
      await putAuthorizationState(oauthState('tokennonce'));

      const tokenRequests: CapturedRequest[] = [];
      interceptAuthorizationServerMetadata();
      interceptUseDPoPNonce('/oauth/token', 'test-nonce-rotated', tokenRequests);
      interceptTokenExchange(tokenRequests);
      interceptGetSession();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(callbackRequest(oauthState('tokennonce')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('error')).toBeNull();
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);

      expect(tokenRequests).toHaveLength(2);
      expect(decodeJWT(tokenRequests[0].headers['dpop']).payload.nonce).toBe(AUTHORIZATION_SERVER_NONCE);
      expect(decodeJWT(tokenRequests[1].headers['dpop']).payload.nonce).toBe('test-nonce-rotated');
    });

    it('calls getSession under the DPoP scheme with a proof bound to the access token', async () => {
      await putAuthorizationState(oauthState('getsession'));

      const sessionRequests: CapturedRequest[] = [];
      interceptTokenRoundTrip();
      interceptGetSession(sessionRequests);
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      await worker.fetch(callbackRequest(oauthState('getsession')), environment);

      expect(sessionRequests).toHaveLength(1);
      expect(sessionRequests[0].headers['authorization']).toBe(`DPoP ${ACCESS_TOKEN}`);

      const proof = sessionRequests[0].headers['dpop'];
      expect(await isSignedBy(proof, dpopPublicKey)).toBe(true);
      const decodedProof = decodeJWT(proof);
      expect(decodedProof.payload).toMatchObject({
        htm: 'GET',
        htu: `${PDS_ORIGIN}/xrpc/com.atproto.server.getSession`,
        ath: await sha256Base64URL(ACCESS_TOKEN),
      });
      // The PDS is a different server from the authorization server, so the
      // authorization server's nonce is not sent to it.
      expect(decodedProof.payload.nonce).toBeUndefined();
    });

    it('retries getSession once when the PDS asks for its own nonce', async () => {
      await putAuthorizationState(oauthState('pdsnonce'));

      const sessionRequests: CapturedRequest[] = [];
      interceptTokenRoundTrip();
      fetchMock
        .get(PDS_ORIGIN)
        .intercept({ path: '/xrpc/com.atproto.server.getSession', method: 'GET' })
        .reply(401, (options: any) => {
          capture(sessionRequests, options);
          return JSON.stringify({ error: 'use_dpop_nonce', message: 'Resource server requires nonce in DPoP proof' });
        }, { headers: { 'DPoP-Nonce': PDS_NONCE, 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } });
      interceptGetSession(sessionRequests);
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(callbackRequest(oauthState('pdsnonce')), environment);

      expect(new URL(response.headers.get('Location')!).searchParams.get('uuid')).toBe(ACCOUNT_UUID);
      expect(sessionRequests).toHaveLength(2);
      expect(decodeJWT(sessionRequests[1].headers['dpop']).payload.nonce).toBe(PDS_NONCE);
    });

    it('redirects with error when token exchange HTTP request fails', async () => {
      await putAuthorizationState(oauthState('valid'));

      interceptAuthorizationServerMetadata();
      fetchMock
        .get(ISSUER)
        .intercept({ path: '/oauth/token', method: 'POST' })
        .reply(400, JSON.stringify({ error: 'invalid_grant' }));

      const response = await worker.fetch(callbackRequest(oauthState('valid')), environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=token_exchange_failed');
    });

    it('rejects a token response that does not grant the atproto scope', async () => {
      await putAuthorizationState(oauthState('scope'));

      interceptAuthorizationServerMetadata();
      interceptTokenExchange(undefined, { scope: 'transition:email' });

      const response = await worker.fetch(callbackRequest(oauthState('scope')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('error')).toBe('token_exchange_failed');
      expect(redirectURL.searchParams.has('access_token')).toBe(false);
    });

    it('rejects a token that is not DPoP bound', async () => {
      await putAuthorizationState(oauthState('bearer'));

      interceptAuthorizationServerMetadata();
      interceptTokenExchange(undefined, { token_type: 'Bearer' });

      const response = await worker.fetch(callbackRequest(oauthState('bearer')), environment);

      expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('token_exchange_failed');
    });

    it('redirects with error when user info fetch fails', async () => {
      await putAuthorizationState(oauthState('valid'));

      interceptTokenRoundTrip();
      fetchMock
        .get(PDS_ORIGIN)
        .intercept({ path: '/xrpc/com.atproto.server.getSession', method: 'GET' })
        .reply(401, JSON.stringify({ error: 'InvalidToken', message: 'Bad token' }));

      const response = await worker.fetch(callbackRequest(oauthState('valid')), environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('error=user_info_failed');
    });

    it('completes full OAuth flow with email in the session', async () => {
      await putAuthorizationState(oauthState('valid'));

      interceptLoginCompletion();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(callbackRequest(oauthState('valid')), environment);

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      const redirectURL = new URL(location);
      expect(redirectURL.origin).toBe('https://app.example.com');

      const userParameter = redirectURL.searchParams.get('user');
      expect(userParameter).toBeTruthy();
      const user = JSON.parse(decodeURIComponent(userParameter!));
      expect(user).toEqual({
        id: DID,
        name: HANDLE,
        email: 'alice@example.com',
        provider: 'bluesky',
      });

      expect(redirectURL.searchParams.get('access_token')).toBe(ACCESS_TOKEN);
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);

      // Verify state was consumed
      const remainingState = await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(oauthState('valid'));
      expect(remainingState).toBeNull();
    });

    it('omits email when the session carries none', async () => {
      await putAuthorizationState(oauthState('noemail'));

      interceptTokenRoundTrip();
      // What getSession returns when transition:email was not granted.
      interceptGetSession(undefined, { email: undefined, emailConfirmed: undefined });
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(callbackRequest(oauthState('noemail')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      const user = JSON.parse(decodeURIComponent(redirectURL.searchParams.get('user')!));
      expect(user.id).toBe(DID);
      // Nothing is made up in its place.
      expect('email' in user).toBe(false);
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);
    });

    it('issues a session JWT whose sub is the account UUID and which carries no jid', async () => {
      await putAuthorizationState(oauthState('session'));

      interceptLoginCompletion();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(callbackRequest(oauthState('session')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      const sessionToken = redirectURL.searchParams.get('session_token');
      expect(sessionToken).toBeTruthy();

      const payload = await verifyJWT(sessionToken!, JWT_SECRET);
      expect(payload).not.toBeNull();
      expect(payload!.sub).toBe(ACCOUNT_UUID);
      expect(payload!.provider).toBe('bluesky');
      expect(payload!.exp - payload!.iat).toBe(86_400);
      // A `jid` claim would make the pipeline reject this as a media token.
      expect('jid' in payload!).toBe(false);
      // The raw provider token is still handed over during the transition.
      expect(redirectURL.searchParams.get('access_token')).toBe(ACCESS_TOKEN);
    });

    it('caches the resolved account UUID for a Supabase outage', async () => {
      await putAuthorizationState(oauthState('cache'));

      interceptLoginCompletion();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      await worker.fetch(callbackRequest(oauthState('cache')), environment);

      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBe(ACCOUNT_UUID);
    });

    it('keeps logging in with no session token when JWT_SECRET is not configured', async () => {
      await putAuthorizationState(oauthState('no-secret'));

      interceptLoginCompletion();
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow());

      const response = await worker.fetch(
        callbackRequest(oauthState('no-secret')),
        { ...environment, JWT_SECRET: undefined },
      );

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('error')).toBeNull();
      expect(redirectURL.searchParams.has('session_token')).toBe(false);
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);
      expect(redirectURL.searchParams.get('access_token')).toBe(ACCESS_TOKEN);
    });

    it('logs a known account in from the KV cache when Supabase is unreachable', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/bluesky/${DID}`, ACCOUNT_UUID);
      await putAuthorizationState(oauthState('outage'));

      interceptLoginCompletion();
      interceptSupabaseOutage();

      const response = await worker.fetch(callbackRequest(oauthState('outage')), environment);

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin).toBe('https://app.example.com');
      expect(redirectURL.searchParams.get('error')).toBeNull();
      expect(redirectURL.searchParams.get('uuid')).toBe(ACCOUNT_UUID);

      const payload = await verifyJWT(redirectURL.searchParams.get('session_token')!, JWT_SECRET);
      expect(payload!.sub).toBe(ACCOUNT_UUID);
    });

    it('fails closed for an unknown account when Supabase is unreachable', async () => {
      await putAuthorizationState(oauthState('fail-closed'));

      interceptLoginCompletion();
      interceptSupabaseOutage();

      const response = await worker.fetch(callbackRequest(oauthState('fail-closed')), environment);

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

      // Only the token round trip is intercepted. Any Supabase call the
      // callback made would hit the disabled network and fail the test — which
      // is the point: the callback must not link, because it cannot tell whose
      // browser it is answering. The verified token `sub` is all it needs.
      interceptTokenRoundTrip();

      const response = await worker.fetch(callbackRequest(oauthState('link')), environment);

      expect(response.status).toBe(302);
      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.origin + redirectURL.pathname).toBe('https://app.example.com/settings');
      expect(redirectURL.searchParams.get('provider')).toBe('bluesky');

      const linkCode = redirectURL.searchParams.get('link_code')!;
      expect(linkCode).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse((await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`link-code/${linkCode}`))!)).toEqual({
        uuid: ACCOUNT_UUID,
        provider: 'bluesky',
        identifier: DID,
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
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBeNull();
      // The ticket is single use.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get('link-ticket/link-ok')).toBeNull();
    });

    it('reports expired and stashes nothing for an unknown, replayed or timed-out ticket', async () => {
      await putAuthorizationState(oauthState('expired'), {
        redirectURI: 'https://app.example.com/settings',
        linkTicket: 'never-issued',
      });

      interceptTokenRoundTrip();

      const response = await worker.fetch(callbackRequest(oauthState('expired')), environment);

      const redirectURL = new URL(response.headers.get('Location')!);
      expect(redirectURL.searchParams.get('link_result')).toBe('expired');
      expect(redirectURL.searchParams.has('link_code')).toBe(false);

      const stashed = await env.AUDIO_UNDERVIEW_OAUTH_STATE.list({ prefix: 'link-code/' });
      expect(stashed.keys).toEqual([]);
    });
  });

  describe('POST /accounts/link-confirm', () => {
    function interceptProviderRoundTrip() {
      interceptTokenRoundTrip();
    }

    function interceptLinkInsert() {
      interceptAccountMissing();
      interceptSupabase('GET', 'users', 200, { uuid: ACCOUNT_UUID });
      interceptSupabase('POST', 'accounts', 201, blueskyAccountRow());
    }

    it('links when the same browser returns with both halves', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('confirm'));
      interceptLinkInsert();

      const response = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        environment,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: 'linked' });
      // Only now does the account become resolvable during a Supabase outage.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBe(ACCOUNT_UUID);
    });

    it('answers 409 when the provider belongs to another account', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('confconflict'));
      interceptSupabase('GET', 'accounts', 200, blueskyAccountRow(OTHER_ACCOUNT_UUID));

      const response = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        environment,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ result: 'conflict' });
      // A conflict must not point the outage cache at the wrong account.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBeNull();
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
        environment,
      );
      // Attacker: holds the nonce and the matching session, but no link code.
      const attackerAttempt = await worker.fetch(
        linkConfirmRequest(attacker.token, { nonce: attacker.nonce }),
        environment,
      );

      expect(victimAttempt.status).toBe(403);
      expect(await victimAttempt.json()).toMatchObject({ error: 'link_binding_failed' });
      expect(attackerAttempt.status).toBe(410);
      expect(await attackerAttempt.json()).toMatchObject({ error: 'link_code_expired' });

      // Zero links: no Supabase interceptors were registered, so any attempt to
      // write would have failed the test outright.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBeNull();
    });

    it('refuses a link code confirmed under a different session', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('reverse'));
      const otherToken = await createSessionToken(OTHER_ACCOUNT_UUID);

      const response = await worker.fetch(
        linkConfirmRequest(otherToken, { link_code: flow.linkCode, nonce: flow.nonce }),
        environment,
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'link_binding_failed' });
    });

    it('refuses a mismatched nonce and burns the code', async () => {
      interceptProviderRoundTrip();
      const flow = await startLinkFlow(oauthState('badnonce'));

      const guessed = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: crypto.randomUUID() }),
        environment,
      );
      const retry = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        environment,
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
        environment,
      );
      const second = await worker.fetch(
        linkConfirmRequest(flow.token, { link_code: flow.linkCode, nonce: flow.nonce }),
        environment,
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(410);
    });

    it('answers 410 for a body that carries no usable link code', async () => {
      const token = await createSessionToken();

      for (const body of [{}, { nonce: LINK_NONCE }, { link_code: 42, nonce: LINK_NONCE }]) {
        const response = await worker.fetch(linkConfirmRequest(token, body), environment);
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
        environment,
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
        environment,
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'accounts_unavailable' });
    });
  });

  describe('POST /link-tickets', () => {
    it('mints a ticket bound to the session sub, plus a nonce for the browser', async () => {
      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', token), environment);

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

      const response = await worker.fetch(request, environment);
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

      const response = await worker.fetch(request, environment);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('returns 401 for a media token that carries jid', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const mediaToken = await signJWT(
        { sub: ACCOUNT_UUID, jid: 'job-1', iat: issuedAt, exp: issuedAt + 300 },
        JWT_SECRET,
      );

      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', mediaToken), environment);
      expect(response.status).toBe(401);
    });

    it('returns 401 for a token signed with the wrong secret', async () => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const forged = await signJWT(
        { sub: ACCOUNT_UUID, iat: issuedAt, exp: issuedAt + 300 },
        'test-not-the-real-secret',
      );

      const response = await worker.fetch(authorizedRequest('/link-tickets', 'POST', forged), environment);
      expect(response.status).toBe(401);
    });

    it('returns 503 when JWT_SECRET is not configured', async () => {
      const token = await createSessionToken();
      const response = await worker.fetch(
        authorizedRequest('/link-tickets', 'POST', token),
        { ...environment, JWT_SECRET: undefined },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'session_tokens_unavailable' });
    });
  });

  describe('GET /accounts', () => {
    it('lists linked providers without the provider-side identifier', async () => {
      interceptSupabase('GET', 'accounts', 200, [googleAccountRow(), blueskyAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts', 'GET', token), environment);

      expect(response.status).toBe(200);
      const body = await response.text();
      expect(JSON.parse(body)).toEqual({
        accounts: [
          { provider: 'bluesky', linkedAt: '2026-01-01T00:00:00.000Z' },
          { provider: 'google', linkedAt: '2026-08-01T00:00:00.000Z' },
        ],
      });
      expect(body).not.toContain('google-sub-1');
      expect(body).not.toContain(DID);
    });

    it('returns 401 without a session token', async () => {
      const request = new Request(`${WORKER_URL}/accounts`, { headers: { Origin: 'https://example.com' } });
      const response = await worker.fetch(request, environment);
      expect(response.status).toBe(401);
    });

    it('returns 503 when Supabase is unreachable', async () => {
      interceptSupabaseOutage();

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts', 'GET', token), environment);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'accounts_unavailable' });
    });
  });

  describe('DELETE /accounts/{provider}', () => {
    it('removes a provider while another login remains', async () => {
      interceptSupabase('GET', 'accounts', 200, [blueskyAccountRow(), googleAccountRow()]);
      interceptSupabase('DELETE', 'accounts', 200, [googleAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/google', 'DELETE', token), environment);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removed: true });
    });

    it('drops the account cache entry so the removed login cannot come back', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/bluesky/${DID}`, ACCOUNT_UUID);
      interceptSupabase('GET', 'accounts', 200, [blueskyAccountRow(), googleAccountRow()]);
      interceptSupabase('DELETE', 'accounts', 200, [blueskyAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/bluesky', 'DELETE', token), environment);

      expect(response.status).toBe(200);
      // Otherwise the disconnected Bluesky account still resolves to this UUID
      // through the Supabase-outage fallback — a login that was never revoked.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBeNull();
    });

    it('refuses to remove the last remaining login', async () => {
      await env.AUDIO_UNDERVIEW_OAUTH_STATE.put(`account/bluesky/${DID}`, ACCOUNT_UUID);
      interceptSupabase('GET', 'accounts', 200, [blueskyAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/bluesky', 'DELETE', token), environment);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'last_account' });
      // A refused removal leaves the cached login alone.
      expect(await env.AUDIO_UNDERVIEW_OAUTH_STATE.get(`account/bluesky/${DID}`)).toBe(ACCOUNT_UUID);
    });

    it('returns 404 for a provider that is not linked', async () => {
      interceptSupabase('GET', 'accounts', 200, [blueskyAccountRow(), googleAccountRow()]);

      const token = await createSessionToken();
      const response = await worker.fetch(authorizedRequest('/accounts/naver', 'DELETE', token), environment);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'account_not_found' });
    });

    it('returns 401 without a session token', async () => {
      const request = new Request(`${WORKER_URL}/accounts/bluesky`, {
        method: 'DELETE',
        headers: { Origin: 'https://example.com' },
      });

      const response = await worker.fetch(request, environment);
      expect(response.status).toBe(401);
    });
  });

  describe('CORS preflight', () => {
    it('allows Authorization and DELETE for an allowed origin', async () => {
      const request = new Request(`${WORKER_URL}/accounts`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      const response = await worker.fetch(request, environment);

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

      const response = await worker.fetch(request, environment);

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
    });
  });

  describe('health check', () => {
    it('returns healthy status', async () => {
      const request = new Request(`${WORKER_URL}/health`, {
        headers: { Origin: 'https://example.com' },
      });
      const response = await worker.fetch(request, environment);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ status: 'healthy', provider: 'bluesky' });
    });
  });
});
