# Authentication / OAuth Flow Specification

Extracted spec of the current OAuth + JWT authentication system, intended as the
source of truth for the planned rewrite that unifies all 10 providers into a
single worker + strategy pattern.

- **Providers:** google, apple, microsoft, facebook, github, discord, kakao,
  naver, linkedin, x
- **Deployed workers today (8):** google, apple, microsoft, facebook, github,
  discord, kakao, naver
- **Package-only, no worker (2):** linkedin, x
- **Actually wired into the running app (2):** google, github only

> Naming follows repo conventions (`sources`, `tools`, `applications`, no
> abbreviations, `.ts` import extensions). Secret **names** are documented; no
> secret **values** were read.

---

## 1. Component map

| Layer | Location | Role |
|-------|----------|------|
| Shared types + helpers | `packages/sign-provider/` | `OAuthUser`, `OAuthProviderID`, provider interface, PKCE/state/nonce generators, client-side JWT decode + localStorage helpers, provider display config |
| Per-provider logic (10) | `packages/{provider}-oauth-provider/` | endpoint constants, authorization-URL builder, callback parser, user-data parser + Zod schema |
| Shared worker helpers | `workers/tools/` (`@audio-underview/worker-tools`) | CORS, callback validation, state verify, JSON/redirect responses, request router, **HS256 JWT sign/verify** |
| Per-provider workers (8) | `workers/{provider}-oauth-provider-worker/` | `/authorize` + `/callback` endpoints, KV state, token exchange, redirect to frontend |
| DB linkage | `packages/supabase-connector/` | `handleSocialLogin`, account/user tables, JWT `sub` = user UUID |
| Token exchange + API auth | `workers/crawler-manager-worker/`, `workers/scheduler-manager-worker/` | `POST /authentication/token` issues the app JWT; `verifyJWT` guards API routes |
| Client | `applications/web/sources/` | `AuthenticationContext`, `use-authentication`, `SignInPage`, `AuthenticationCallbackPage`, `SignInButtons` |

---

## 2. End-to-end flow (current, google/github path)

```
[1] User clicks "Sign in with Google" (SignInButtons)
      └─ AuthenticationContext.loginWithGoogle()
      └─ redirect: {GOOGLE_OAUTH_WORKER_URL}/authorize?redirect_uri={origin}/authentication/callback

[2] OAuth worker  GET /authorize
      ├─ read redirect_uri (400 if missing)
      ├─ state = generateState()   (32-char alnum)
      ├─ KV.put(state, redirect_uri, { expirationTtl: 300 })   // 5 min
      └─ 302 → provider authorize URL
             (client_id, redirect_uri={workerOrigin}/callback, response_type=code,
              scope, state, provider-specific extras)

[3] Provider authenticates user, 302 → {workerOrigin}/callback?code&state

[4] OAuth worker  GET /callback   (Apple/Naver differ — see §6)
      ├─ validateCallbackParameters(): error? / missing code|state? → redirect to FRONTEND_URL?error=...
      ├─ verifyState(): KV.get(state); missing → invalid_state; then KV.delete(state)   // single-use
      ├─ POST token endpoint (code + client_id + client_secret) → { access_token, id_token?, ... }
      ├─ derive OAuthUser (decode id_token OR call user-info endpoint)
      ├─ (google/github only) handleSocialLogin(supabase) → user UUID  (create user+account if new)
      └─ 302 → storedRedirectURI (frontend callback)
             ?user={urlencoded JSON OAuthUser}&access_token={provider token}
             [&id_token=...] [&uuid={supabase UUID}]

[5] Client  /authentication/callback (AuthenticationCallbackPage)
      ├─ if ?error → toast + navigate /sign/in
      ├─ parse & Zod-validate `user`; require `user` + `access_token`
      ├─ POST {CRAWLER_MANAGER_WORKER_URL}/authentication/token
      │      body { provider, access_token }, 10s timeout
      │      → crawler-manager re-resolves provider user, looks up Supabase account,
      │        signs app JWT (HS256, sub=account.uuid, exp=+24h)
      │      → { token, token_type:"Bearer", expires_in:86400 }
      └─ loginWithProvider(provider, user, token, expires_in*1000)
             └─ localStorage["sign-provider-auth"] = { user, credential: JWT, expiresAt }
             └─ navigate /home

[6] Subsequent API calls (use-crawler-manager / use-scheduler-manager)
      └─ Authorization: Bearer {JWT from localStorage.credential}
      └─ worker verifyJWT() → payload.sub = userUUID → authorize route
```

Key architectural point: the **provider access_token is never used as the app
credential**. It is exchanged for a self-issued HS256 JWT by the crawler-manager
worker; that JWT is what the client stores and sends. The OAuth worker's
`access_token` in the redirect is only a short-lived proof for step 5.

---

## 3. `sign-provider` package (shared contract)

### 3.1 `OAuthProviderID` (`types/user.ts`)
Zod enum: `google, apple, microsoft, facebook, github, x, linkedin, discord, kakao, naver`.

### 3.2 `OAuthUser` schema
```
id:       string (min 1, required)
email:    email | null | undefined       // optional — X never provides it
name:     string (min 1, required)
picture:  url (optional)
provider: OAuthProviderID
uuid:     uuid (optional)
```
`parseOAuthUser` throws on invalid; providers must normalize their responses to
this shape.

### 3.3 `StoredAuthenticationData` (client persistence shape)
```
user:       OAuthUser
credential: string (min 1)   // the HS256 app JWT
expiresAt:  number (positive, epoch ms)
```
- `createStoredAuthenticationData(user, credential, durationMs = 24h)` →
  `expiresAt = Date.now() + duration`.
- `isAuthenticationExpired(data)` → `expiresAt <= Date.now()`.

### 3.4 Provider interface (`types/provider.ts`)
Each package's `OAuthProvider` object implements:
`providerID, displayName, authorizationEndpoint, tokenEndpoint, userInfoEndpoint?`
+ methods `buildAuthorizationURL(parameters)`, `parseCallbackParameters(url)`,
`parseUserData(data) → OAuthUser`.

`OAuthAuthorizationParameters`: clientID, redirectURI, responseType, scopes[],
state, nonce?, codeChallenge?, codeChallengeMethod?('S256'|'plain'),
additionalParameters?.

`OAuthTokenResponse`: accessToken, tokenType, expiresIn?, refreshToken?, idToken?, scope?.

### 3.5 Crypto / random helpers (Web Crypto)
| Function | Default | Alphabet / method |
|----------|---------|-------------------|
| `generateState(len=32)` | 32 | `[A-Za-z0-9]`, `crypto.getRandomValues` |
| `generateNonce(len=32)` | 32 | delegates to `generateState` |
| `generateCodeVerifier(len=64)` | 64 | `[A-Za-z0-9-._~]` (PKCE unreserved) |
| `generateCodeChallenge(verifier)` | — | SHA-256 → base64url (S256) |

> Note: `state` uses `value % alphabet.length` over random bytes → slight modulo
> bias. Not a real weakness at 32 chars but worth noting for the rewrite.

### 3.6 Client JWT decode (`tools/jwtDecode.ts`)
`jwtDecode<T>` — base64url-decodes the **payload only, no signature check**
(comment explicitly says this is safe because the server already verified).
`getJWTExpiration` (→ ms), `isJWTExpired` (no `exp` ⇒ treated as *not* expired).

### 3.7 Storage (`tools/storage.ts`)
`localStorage` key default `sign-provider-auth`. `save/load/clear/hasValid`.
`load` removes the entry on invalid JSON, schema-invalid, or expired.

### 3.8 Display config (`providers/configurations.ts`)
`PROVIDER_DISPLAY_CONFIGURATIONS: Record<OAuthProviderID, ...>` — display name,
colors, icon type (fontawesome | custom | text | svg). Kakao & Naver ship inline
SVG paths. Purely presentational.

---

## 4. Provider packages — common vs. differences

### 4.1 What is common (the strategy shape)
Every `packages/{p}-oauth-provider/` has identical structure:
`configuration.ts` (endpoint + scope constants + config interface),
`provider.ts` (Zod schema + `parseX`, an `OAuthProvider` object, a
`createXAuthorizationURL(...)` convenience fn, a `parseXUserFrom...` fn),
`index.ts` (re-exports). The `buildAuthorizationURL` skeleton (set client_id /
redirect_uri / response_type / scope / state, then optional nonce/PKCE/extras)
is copy-pasted across all 10 with per-provider deltas.

### 4.2 Endpoints & scopes

| Provider | Authorize endpoint | Token endpoint | User-info endpoint | Default scopes |
|----------|--------------------|----------------|--------------------|----------------|
| google | `accounts.google.com/o/oauth2/v2/auth` | `oauth2.googleapis.com/token` | `www.googleapis.com/oauth2/v3/userinfo` | `openid email profile` |
| apple | `appleid.apple.com/auth/authorize` | `appleid.apple.com/auth/token` | — (ID token only) | `name email` |
| microsoft | `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize` | `.../{tenant}/oauth2/v2.0/token` | `graph.microsoft.com/v1.0/me` | `openid email profile` |
| facebook | `www.facebook.com/v22.0/dialog/oauth` | `graph.facebook.com/v22.0/oauth/access_token` | `graph.facebook.com/v22.0/me` | `email public_profile` |
| github | `github.com/login/oauth/authorize` | `github.com/login/oauth/access_token` | `api.github.com/user` | `user:email` |
| discord | `discord.com/api/oauth2/authorize` | `discord.com/api/oauth2/token` | `discord.com/api/users/@me` | `identify email` |
| kakao | `kauth.kakao.com/oauth/authorize` | `kauth.kakao.com/oauth/token` | `kapi.kakao.com/v2/user/me` | `profile_nickname profile_image account_email` |
| naver | `nid.naver.com/oauth2.0/authorize` | `nid.naver.com/oauth2.0/token` | `openapi.naver.com/v1/nid/me` | `['']` (none — configured in Naver console) |
| linkedin | `www.linkedin.com/oauth/v2/authorization` | `www.linkedin.com/oauth/v2/accessToken` | `api.linkedin.com/v2/userinfo` | `openid profile email` |
| x | `twitter.com/i/oauth2/authorize` | `api.twitter.com/2/oauth2/token` | `api.twitter.com/2/users/me` | `users.read tweet.read offline.access` |

Extra endpoints defined but not exercised by workers: google/apple/discord/x
`REVOKE`, apple `PUBLIC_KEYS`, microsoft `LOGOUT`/`GRAPH_API`, kakao
`LOGOUT`/`UNLINK`.

### 4.3 Authorization-URL / parameter differences (`buildAuthorizationURL`)

| Provider | Scope separator | PKCE | Nonce | Special params / behaviour |
|----------|-----------------|------|-------|----------------------------|
| google | space | optional | optional | `access_type=online` when `response_type` includes `id_token`; `prompt`, `login_hint`, `hd` (hosted domain) options |
| apple | space | optional | optional | `response_mode` (default `query`; worker forces `form_post` when name/email scopes); callback code can arrive in hash |
| microsoft | space | optional | optional | tenant-templated endpoints; `prompt` incl. `login`; `domain_hint` (consumers/organizations) |
| facebook | **comma** | optional | **none** | `auth_type` (rerequest/reauthenticate), `display` (page/popup/touch); no OIDC |
| github | space | **none** | none | omits `response_type` entirely; `allow_signup`, `login` options |
| discord | space | optional | none | `prompt` (none/consent), `guild_id`, `disable_guild_select`, `permissions` |
| kakao | **comma** (only if scopes non-empty) | none | optional | `prompt` incl. `login`, `service_terms` |
| naver | — (no scope param) | none | none | scopes intentionally omitted from URL |
| linkedin | space | optional | optional | OIDC via `openid`; `prompt` (none/consent) |
| x | space | **required** (throws if no codeChallenge) | none | mandatory PKCE S256; `createXAuthorizationURL` takes `codeChallenge` as a required arg |

### 4.4 User-data acquisition & `parseUserData` differences

| Provider | Source of identity | Zod schema shape | id → OAuthUser.id | email fallback | name fallback |
|----------|--------------------|-------------------|-------------------|----------------|---------------|
| google | ID token (JWT) | `sub, email, name, picture, ...` | `sub` | (email required) | `name` |
| apple | ID token; `name` only on first sign-in via separate `user` param | `sub, email, is_private_email, real_user_status, nonce, auth_time`; separate `AppleUserName {first/last/middle}` | `sub` | — | joined name parts, else `email.split('@')[0]` |
| microsoft | ID token or Graph `/me` | `sub, email?, preferred_username?, name?, oid, tid` | `sub` (ID token) / `id` (Graph) | `email ?? preferred_username ?? ''` | `name ?? given_name ?? email-prefix` |
| facebook | Graph `/me` (REST) | `id, email?, name?, first/last_name, picture.data.url` | `id` | `{id}@facebook.com` | `name` or first+last, else id |
| github | REST `/user` (`id` is number) | `id:number, login, email?, name?, avatar_url, ...` | `id.toString()` | `{login}@users.noreply.github.com` | `name ?? login` |
| discord | REST `/users/@me` | `id, username, discriminator, global_name?, avatar?, email?, verified?` | `id` | **throws if email missing** | `global_name ?? username` |
| kakao | REST `/v2/user/me` (nested `kakao_account`) | `id:number, properties, kakao_account.{email,name,profile}` | `id.toString()` | `{id}@kakao.com` | account name → profile nickname → props nickname → `KakaoUser{id}` |
| naver | REST `/v1/nid/me` (wrapped `{ resultcode, message, response }`) | `response.{id, email?, name?, nickname?, profile_image?, ...}` | `response.id` | `''` | `name ?? nickname ?? ''` |
| linkedin | OIDC UserInfo | `sub, email?, name?, given_name?, picture?` | `sub` | `email ?? null` | `name ?? given_name ?? sub` |
| x | REST `/2/users/me` (wrapped `{ data }`) | `data.{id, username, name, profile_image_url, ...}` | `data.id` | **always `null`** (email needs X approval) | `data.name` |

Callback parsing: google & apple also read URL **fragment** (implicit-flow /
form_post). REST-based providers (facebook/github/discord/kakao/naver/x) read
query params only.

---

## 5. Worker: shared `worker-tools` (`workers/tools/`)

### 5.1 Router (`worker-handler.ts` → `createOAuthWorkerHandler`)
Routes by pathname:
- `OPTIONS *` → CORS preflight (`handleOptions`)
- `/authorize` → `handlers.handleAuthorize`
- `/callback` → `handlers.handleCallback`
- `/health` → `{ status:"healthy", provider }`
- else → 404 `not_found`; uncaught error → 500 `server_error`

### 5.2 CORS (`cors.ts`)
- `ALLOWED_ORIGINS` = comma list (env). Origin must match exactly or `*`.
- Non-wildcard match sets `Access-Control-Allow-Origin: {origin}`,
  `Allow-Credentials: true`, `Vary: Origin`.
- Methods `GET, POST, OPTIONS`; allowed header `Content-Type`.
- Preflight returns 204.

### 5.3 Callback validation & state (`callback-validation.ts`)
- `validateCallbackParameters(url,...)`: `?error` → redirect w/ error;
  missing `code|state` → `invalid_request`.
- `verifyState(state, kv, ...)`: `KV.get(state)`; missing → `invalid_state`;
  on success **deletes the key (single-use)**; delete failure is logged, not fatal.

### 5.4 App JWT (`jwt.ts`) — **HS256**
```
header  { alg: "HS256", typ: "JWT" }
payload { sub, iat, exp, [additional] }
sign    HMAC-SHA-256(secret) via Web Crypto
```
`signJWT(payload, secret)`, `verifyJWT(token, secret)`.
`verifyJWT` returns `null` unless: 3 parts, valid HMAC, `sub` is string,
`iat`/`exp` numbers, and `exp >= now`. This is the credential the client stores;
**distinct from the provider ID tokens**, which are HS256-unrelated (RS256/ES256
from the providers, decoded but never verified here).

### 5.5 KV state record
- Binding: `AUDIO_UNDERVIEW_OAUTH_STATE` (same namespace id
  `6a8c4022e9984b0fb81957ed410ad9b0` across all 8 workers).
- **TTL: 300 s** everywhere.
- Value shape:
  - Simple workers (google, github, facebook, discord, kakao, naver): value =
    **raw `redirect_uri` string**.
  - apple & microsoft: value = **JSON** `{ redirectURI, nonce }` (they generate a
    nonce and verify state manually rather than via `verifyState`).
- Key = the `state` string. Single-use (deleted on callback).

### 5.6 Endpoint contract (per worker)

| Method | Path | Request | Response |
|--------|------|---------|----------|
| GET | `/authorize` | `?redirect_uri=` (required) | 302 → provider authorize URL; 400 if missing |
| GET (POST for apple form_post) | `/callback` | `?code&state` (+ apple `user`, error params) | 302 → frontend `redirect_uri?user&access_token[&id_token][&uuid]`; naver returns **200 auto-submitting HTML POST form** |
| OPTIONS | any | — | 204 + CORS |
| GET | `/health` | — | 200 `{status:"healthy", provider}` |

Redirect to frontend on success carries: `user` (urlencoded JSON `OAuthUser`),
`access_token`, optionally `id_token`, and (google/github only) `uuid`.

### 5.7 wrangler / env-var differences

| Worker | `nodejs_compat` | Axiom instrument | Supabase (`handleSocialLogin`) | Notable secrets |
|--------|-----------------|------------------|-------------------------------|-----------------|
| google | yes | yes | **yes** (writes uuid) | GOOGLE_CLIENT_ID/SECRET, SUPABASE_URL/SECRET_KEY, AXIOM_API_TOKEN |
| github | yes | yes | **yes** (writes uuid) | GITHUB_CLIENT_ID/SECRET, SUPABASE_*, AXIOM_* |
| microsoft | no | yes | no | MICROSOFT_CLIENT_ID/SECRET; `MICROSOFT_TENANT` var (default `common`) |
| apple | no | no | no | APPLE_CLIENT_ID (Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (PEM) |
| facebook | no | no | no | FACEBOOK_CLIENT_ID/SECRET |
| discord | no | no | no | DISCORD_CLIENT_ID/SECRET |
| kakao | no | no | no | KAKAO_CLIENT_ID (REST key), KAKAO_CLIENT_SECRET (optional) |
| naver | no | no | no | NAVER_CLIENT_ID/SECRET |

All: `FRONTEND_URL`, `ALLOWED_ORIGINS`
(`http://localhost:5173,https://audio-underview.pages.dev`),
`compatibility_date = 2025-11-25`, observability logs enabled.

> Inconsistency for the rewrite: only google & github persist the user to
> Supabase and emit `uuid`. The other 6 workers redirect a `user` blob but never
> create the account row that step-5 token-exchange later requires — so those
> providers cannot actually complete login end-to-end.

---

## 6. Worker per-provider callback deltas (vs. google baseline)

- **apple** — biggest divergence. Generates a **client_secret JWT (ES256)** on
  every callback (`generateAppleClientSecret`): header `{alg:ES256, kid:KEY_ID}`,
  payload `{iss:TEAM_ID, iat, exp:+15777000 (6 months, Apple max),
  aud:"https://appleid.apple.com", sub:CLIENT_ID}`, signed with PKCS8 P-256 key
  imported from `APPLE_PRIVATE_KEY`. Accepts **POST form_post or GET** callbacks;
  parses `user` (name) from form body on first sign-in; JSON state `{redirectURI,
  nonce}`; requires `id_token`; no Supabase.
- **microsoft** — tenant-aware endpoints (`getMicrosoftAuthorizationEndpoint(tenant)`);
  generates nonce; JSON state `{redirectURI, nonce}`, manual state verify;
  ID token or Graph `/me`; no Supabase; keeps `id_token` in redirect.
- **facebook** — token exchange via **GET** with query params (not POST body);
  comma scopes; user-info fetched with `fields=` + `access_token` query param;
  no Supabase.
- **github** — POST token exchange with `Accept: application/json`; handles
  "200 with error body"; if profile lacks email, secondary call to
  `/user/emails` for primary verified email; **Supabase** enabled.
- **discord** — CDN avatar URL built from `avatar` hash; **rejects login with
  `email_required`** if no email; `prompt=consent`; no Supabase.
- **kakao** — comma scopes; `client_secret` optional; deeply nested
  `kakao_account` parsing; no Supabase.
- **naver** — token exchange via query params; wrapper `resultcode`/`message`
  error check; **callback returns a self-submitting HTML `<form method=POST>`**
  to the frontend (not a 302) with HTML-escaped values + `http/https` scheme
  validation on the stored redirect URI; no Supabase.

---

## 7. Token-exchange worker (`crawler-manager` / `scheduler-manager`)

`POST /authentication/token` (unauthenticated). Body `{ provider, access_token }`.
- `provider` restricted to **`'google' | 'github'`** only.
- Re-resolves the provider user server-side (google `oauth2/v3/userinfo` → `sub`,
  github `api.github.com/user` → `id`), 5 s timeout.
- `findAccount(supabase, {provider, identifier})` — **must already exist** (401 if not).
- Signs app JWT: `{ sub: account.uuid, iat, exp: +86400 }`, HS256 with `JWT_SECRET`.
- Returns `{ token, token_type:"Bearer", expires_in:86400 }`.

The two token-exchange modules are byte-identical except module name, `User-Agent`,
and `undefined` vs `null` return sentinel. API routes (`/crawlers*`) require
`Authorization: Bearer {JWT}`; `verifyJWT` → `payload.sub` = userUUID.

---

## 8. Client (`applications/web`)

- **Wiring:** `main.tsx` → `Application` passes only `googleWorkerURL`
  (`VITE_GOOGLE_OAUTH_WORKER_URL`) and `githubWorkerURL`
  (`VITE_GITHUB_OAUTH_WORKER_URL`). `AuthenticationContext` has **hardcoded
  `loginWithGoogle` / `loginWithGitHub` only**; `loginWithProvider` is the
  generic save path used by the callback page.
- **`ENABLED_PROVIDERS`** (Application.tsx) lists 8 (google, apple, microsoft,
  facebook, github, discord, kakao, naver) — linkedin & x excluded. But only
  google/github buttons trigger a real redirect; the rest fall to
  `onProviderClick` → toast "아직 구현되지 않았습니다".
- **Routes:** `/sign/in` (SignInPage), `/authentication/callback`
  (AuthenticationCallbackPage), protected routes via `ProtectedRoute` →
  redirect `/sign/in`.
- **Callback page** re-validates `user` with its own local Zod schema (note:
  `email` is `z.email()` **required** here, stricter than sign-provider's
  optional/nullable — X/naver empty email would fail this), exchanges
  access_token → JWT at `VITE_CRAWLER_MANAGER_WORKER_URL/authentication/token`,
  then `loginWithProvider(provider, user, jwt, expires_in*1000)`.
- **Token storage:** `localStorage["sign-provider-auth"]` =
  `{ user, credential: JWT, expiresAt }`. Read on context init (expired/invalid
  cleared). API hooks read `.credential` and send as Bearer.
- **Refresh policy:** none. No refresh-token handling. On `expiresAt` the stored
  data is discarded on next load and the user must re-authenticate. Logout =
  `localStorage.removeItem` + `queryClient.clear()`.
- **Legacy:** `VITE_GOOGLE_CLIENT_ID` still required by env schema, marked
  "TODO: remove after worker redirect flow migration".

---

## 9. Why linkedin & x have packages but no workers

Git history (`feature: add {linkedin,x}-oauth-provider package`, then CodeRabbit
review-fix commits) shows both packages were added in the same OAuth-package
batch as the others, with full `provider.ts` + tests, but **no worker was ever
created** (`git log` for `workers/linkedin*` / `workers/x-*` returns nothing).
Assessment: **intentionally incomplete / staged** — the provider strategy layer
was built out to all 10 for completeness, but only the 8 with workers were
targeted for deployment, and only google/github were wired end-to-end. X in
particular needs mandatory PKCE (code_verifier must survive the redirect) which
the current stateless KV-string state model does not carry, so its worker was
likely deferred until the flow supports PKCE. LinkedIn appears simply not yet
prioritized. Neither is in `ENABLED_PROVIDERS`.

---

## 10. Security findings / rewrite improvement points

1. **Only google/github complete end-to-end.** The other 6 deployed workers
   redirect a `user` blob but never `handleSocialLogin`, and token-exchange only
   accepts `google|github` — so apple/microsoft/facebook/discord/kakao/naver
   logins dead-end at step 5. Unify account creation into the shared handler.
2. **`access_token` in redirect URL.** Provider access tokens are placed in the
   frontend redirect query string (browser history, logs, `Referer`). The design
   intent is that it is single-use for token-exchange, but it is not bound to the
   state/nonce and not expired server-side. Prefer a server-side session or
   one-time code.
3. **`user` blob is client-trusted then server-reverified — asymmetrically.**
   The redirect trusts the worker-built `user`, but token-exchange independently
   re-resolves identity from the provider. Good that it reverifies; but the
   client Zod schema (`email` required) is stricter than the canonical schema
   (email optional/nullable) → X and email-less naver users break at the callback.
4. **PKCE generated but never used in the deployed flow.** `generateCodeVerifier`
   /`generateCodeChallenge` exist and X *requires* PKCE, but no worker stores a
   verifier in KV. Any auth-code-flow provider should use PKCE; the state record
   should carry `codeVerifier`.
5. **State modulo bias** in `generateState` (`byte % 62`). Minor; use rejection
   sampling or `crypto.randomUUID`-style base for uniformity.
6. **ID tokens are never signature-verified.** `jwtDecode` (client) and the
   worker's `jwtDecode<...>(id_token)` decode without verifying provider
   signatures (apple keys endpoint & google JWKS are defined/available but
   unused). Verify `id_token` against provider JWKS, and validate `nonce`/`aud`.
7. **Nonce stored but not validated.** apple/microsoft put `nonce` in KV state but
   never compare it against the returned ID token's `nonce` claim.
8. **App JWT is HS256 with a shared `JWT_SECRET`.** Fine for a single trust domain
   but means every worker holding the secret can mint tokens. Consider asymmetric
   (RS/ES256) signing if issuance is centralized.
9. **Duplicated token-exchange module** across crawler-manager & scheduler-manager
   (byte-identical). Move into `worker-tools`.
10. **`fetch` error hygiene inconsistent.** Some workers check "200-with-error-body"
    (github, naver), others do not. Standardize in the unified worker.
11. **Naver HTML auto-submit form** is a distinct callback response mode
    (200 + `<form method=POST>`) vs. everyone else's 302 — the unified worker's
    strategy interface must model "redirect vs. form_post response".
12. **Shared KV namespace id** across all workers is fine for a single unified
    worker, but keys are global `state` strings with no provider prefix — collision-safe
    only because state is random. A unified worker should namespace keys per provider/flow.

---

## 11. Recommended strategy interface for the rewrite

A single worker + per-provider strategy should capture these variable axes
(everything else is common):

```
interface ProviderStrategy {
  id: OAuthProviderID;
  authorizationEndpoint(env): string;      // microsoft: tenant-templated
  tokenEndpoint(env): string;
  userInfoEndpoint?: string;
  defaultScopes: string[];
  scopeSeparator: ' ' | ',';               // facebook/kakao = ','
  usesPKCE: boolean;                        // x = true
  usesNonce: boolean;                       // apple/microsoft/google/linkedin
  clientSecret(env): Promise<string>;       // apple = ES256 JWT, others = static
  tokenRequestStyle: 'post_body' | 'get_query';  // facebook/naver = get_query
  callbackResponseMode: 'redirect' | 'html_form'; // naver = html_form
  extraAuthorizeParams(env): Record<string,string>;
  identitySource: 'id_token' | 'userinfo';
  parseUser(data): OAuthUser;               // per-provider normalization
  requiresEmail: boolean;                   // discord throws without it
}
```
State record (KV, TTL 300s) should become a JSON envelope for all providers:
`{ provider, redirectURI, nonce?, codeVerifier? }`.
