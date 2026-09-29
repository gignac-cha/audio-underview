# 로그인 provider 확장 — 워커 6종 교체와 워커 7종 추가

2026-09-28. 상태: 구현 완료(작업 트리, 커밋 전). 워커 13종 REFUTE 14항목 GREEN. §5의 4~9는 사람 몫. 이 문서는 이관 단위가 아니라 **신규 개발** 문서다. 실행 규약은 `documents/migration/00-migration-plan.md` §8을 준용하되, 출처 커밋 복사 규칙(§8.1)은 해당 없다. 참조 구현은 이 브랜치의 `workers/github-oauth-provider-worker`(커밋 `356835f`)다.

Linear: 미발급. 브랜치: 이 작업은 `feature/login-workers-migration` 위에서 시작한다 — 커밋 `356835f`가 추가한 connector 모듈(세션 토큰·계정 연결·계정 라우트·요청 정책)에 의존하기 때문이다.

## 0. 결정사항

- **기존 워커 6종(apple·microsoft·facebook·discord·kakao·naver)을 github 워커와 같은 구조로 교체한다.** 바뀌는 것은 계정 결정(Supabase + KV 저장 UUID), 세션 JWT 발급, `redirect_uri` 허용 목록, state 형식 검사, 보호 라우트 4개, CORS 확장, Axiom 계측이다. provider 고유 처리(애플의 POST 콜백과 client secret JWT, 카카오의 선택적 secret, 마이크로소프트의 tenant, 네이버의 중첩 응답)는 그대로 둔다.
- **provider 4종(threads·tiktok·line·bluesky)을 새로 추가한다.** provider 패키지와 워커를 새로 만들고, 공용 provider 목록·표시 설정·DB 열거형·배포 워크플로를 확장한다.
- **워커 10종은 모두 같은 계약(§3)을 지킨다.** 검증은 이 계약으로 한다.
- **의존성 변경은 레인 S 한 곳에서만 한다.** 레인 10개가 동시에 lockfile을 만지면 깨지므로, 레인 S가 먼저 순차로 끝낸 뒤 나머지가 병렬로 돈다. 구현 레인은 `package.json`·`pnpm-lock.yaml`을 만지지 않는다.
- **이메일을 주지 않는 provider는 email을 생략한다.** 지어낸 주소를 넣지 않는다. `OAuthUser.email`은 선택 필드다.
- **웹과 crawler-manager는 손대지 않는다(§9).**
- **추가 범위(2026-09-28, §11): linkedin·x·twitch 워커를 추가한다.** linkedin·x는 provider 패키지가 이미 있고 워커만 없다. x 패키지는 현재 공식 문서에 맞게 고친다. twitch는 패키지부터 새로 만든다.
- **worker-tools의 provider 타입을 공용 provider 목록(`OAuthProviderID`)으로 바꾼다(§11.1).** 1차 실행에서 이 닫힌 타입이 새 provider를 거부해 LINE 워커가 막혔고, threads·tiktok·bluesky는 각자 다른 cast로 우회했다. 이 타입에는 어디서도 쓰지 않는 `twitch`·`twitter`가 있고 `x`·`linkedin`이 빠져 있었다. 공용 패키지 무변경 원칙의 예외는 이 한 곳뿐이다.

## 1. 단위의 경계

**들어오는 것**

| 대상 | 조치 | 레인 |
| -- | -- | -- |
| `packages/sign-provider` — provider 목록·표시 설정·테스트 3파일 | 4종 추가 | S |
| `packages/supabase-connector/migrations/009_add_login_providers.sql` | 신규 | S |
| `.github/workflows/deploy-oauth-workers.yml` | 입력 4개·job 4개 추가 | S |
| 워커 6종 `package.json` | 의존성 추가(`pnpm add`) | S |
| 패키지 4종·워커 4종 scaffolding(`package.json`·`tsconfig.json`·`vitest.config.ts`·`wrangler.toml`) | 신규 | S |
| 워커 6종 `sources/index.ts`·`tests/index.test.ts`·`vitest.config.ts`·`wrangler.toml` | 교체 | U-apple … U-naver |
| 패키지 4종 `sources/**`, 워커 4종 `sources/**`·`tests/**` | 신규 | N-threads … N-bluesky |
| `workers/tools/sources/types.ts`의 `OAuthProvider` 타입, twitch 목록·마이그레이션·배포 job, linkedin·x·twitch 골격, LINE `nodejs_compat`, threads·tiktok·bluesky cast 제거 | 추가 범위 | S2 (§11) |
| `packages/twitch-oauth-provider/sources/**`, `packages/x-oauth-provider/sources/**`, 워커 3종 `sources/**`·`tests/**` | 추가 범위 | N-linkedin, N-x, N-twitch (§11) |

**안 들어오는 것**

- `workers/google-oauth-provider-worker`, `workers/github-oauth-provider-worker` — 참조 구현. 읽기만 한다.
- `packages/supabase-connector/sources/**`, `workers/tools/**`(패키지 이름 `@audio-underview/worker-tools`), `packages/axiom-logger/**`, `packages/logger/**` — 공용 패키지. 바꾸지 않는다.
- `applications/web/**`, `workers/crawler-manager-worker/**` — §9.
- 워커 6종의 `name`·KV `id`·`ALLOWED_ORIGINS` 값.

## 2. 파일 단위 지시

### 2.1 레인 S — scaffolding과 공용 목록 (Sonnet 5, 순차, 가장 먼저)

| 대상 | 조치 |
| -- | -- |
| `packages/sign-provider/sources/types/user.ts` | `oauthProviderID` 열거형 끝에 `'threads'`, `'tiktok'`, `'line'`, `'bluesky'` 추가 |
| `packages/sign-provider/sources/types/user.test.ts` | 60행 근처 providers 배열에 같은 4개 추가 |
| `packages/sign-provider/sources/providers/configurations.ts` | `PROVIDER_DISPLAY_CONFIGURATIONS`에 4개 추가. 값은 §2.1.1 |
| `packages/supabase-connector/migrations/009_add_login_providers.sql` | 신규. 내용은 §2.1.2 |
| `.github/workflows/deploy-oauth-workers.yml` | `inputs`에 `threads`·`tiktok`·`line`·`bluesky`(boolean, default false) 추가, naver job을 본떠 job 4개 추가. 시크릿 이름은 §2.3.1 |
| 워커 6종 `package.json` | 각 워커 디렉터리에서 `pnpm add @audio-underview/supabase-connector@workspace:*`. microsoft를 뺀 5종에는 `pnpm add @audio-underview/axiom-logger@workspace:*`도 |
| `packages/<p>-oauth-provider/` (p = threads·tiktok·line·bluesky) | `packages/naver-oauth-provider`의 `package.json`·`tsconfig.json`·`vitest.config.ts`를 복사하고 `name`만 `@audio-underview/<p>-oauth-provider`로 변경. `sources/`는 만들지 않는다 |
| `workers/<p>-oauth-provider-worker/` | `workers/naver-oauth-provider-worker`의 `package.json`·`tsconfig.json`·`wrangler.toml`을 복사. `package.json`은 `name` 변경 + 의존성을 github 워커와 같은 6개(provider 패키지만 `<p>`로)로 맞춘다. `wrangler.toml`은 `name = "audio-underview-<p>-oauth-provider-worker"`, `[vars]`에 `AXIOM_DATASET = "audio-underview"` 추가, 필수 시크릿 주석을 §2.3.1로 교체. KV `id`·binding·`ALLOWED_ORIGINS`는 그대로. `vitest.config.ts`는 github 워커 것을 복사해 provider 시크릿 이름만 §2.3.1로 교체. `sources/`·`tests/`는 만들지 않는다 |
| `workers/bluesky-oauth-provider-worker/` | 위에 더해 `pnpm add @atproto/oauth-client@latest @atproto/jwk-webcrypto@latest` |
| 마지막 | 루트에서 `pnpm install` 한 번 |

#### 2.1.1 표시 설정 값

| providerID | displayName | backgroundColor | textColor | iconType | iconName |
| -- | -- | -- | -- | -- | -- |
| threads | Threads | `#000000` | `#FFFFFF` | fontawesome | faThreads |
| tiktok | TikTok | `#000000` | `#FFFFFF` | fontawesome | faTiktok |
| line | LINE | `#06C755` | `#FFFFFF` | fontawesome | faLine |
| bluesky | Bluesky | `#1185FE` | `#FFFFFF` | fontawesome | faBluesky |

#### 2.1.2 마이그레이션 009

```sql
-- Migration: Add login providers threads, tiktok, line, bluesky to provider_type
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'threads';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'tiktok';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'line';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'bluesky';
```

### 2.2 레인 U-<p> — 기존 워커 교체 (Opus 5.5, 6개 병렬, p = apple·microsoft·facebook·discord·kakao·naver)

파일 소유: `workers/<p>-oauth-provider-worker/**`. 단 `package.json`은 레인 S가 끝냈으므로 만지지 않는다.

| 대상 파일 | 조치 |
| -- | -- |
| `sources/index.ts` | github 워커 `sources/index.ts`와 **구조를 같게** 다시 쓴다. 다른 곳은 provider 고유 부분뿐이다: 엔드포인트·scope·토큰 교환 요청·사용자 정보 조회와 매핑·`PROVIDER` 상수·`Environment`의 provider 필드. 현재 `<p>` 워커에 있는 provider 고유 처리는 유지한다 |
| `tests/index.test.ts` | github 워커 `tests/index.test.ts`(53 케이스)를 `<p>`에 맞게 옮기고, 현재 `<p>` 테스트 중 provider 고유 케이스를 보존한다. §3의 동작마다 검증 테스트가 있어야 한다 |
| `vitest.config.ts` | github 워커 것을 복사해 provider 시크릿 이름만 바꾼다(`JWT_SECRET`·확장된 `ALLOWED_ORIGINS`·Supabase·Axiom 더미 값 포함) |
| `wrangler.toml` | `[vars]`에 `AXIOM_DATASET = "audio-underview"` 추가(microsoft 포함), 필수 시크릿 주석에 `SUPABASE_URL`·`SUPABASE_SECRET_KEY`·`AXIOM_API_TOKEN`·`JWT_SECRET` 추가. `name`·KV `id`·`ALLOWED_ORIGINS`·기존 vars는 그대로 |

### 2.3 레인 N-<p> — 새 provider (Opus 5.5, 4개 병렬, p = threads·tiktok·line·bluesky)

파일 소유: `packages/<p>-oauth-provider/sources/**`, `workers/<p>-oauth-provider-worker/sources/**`·`tests/**`. 레인 S가 만든 `vitest.config.ts`·`wrangler.toml`의 시크릿 이름이 §2.3.1과 다르면 고쳐도 된다. `package.json`은 만지지 않는다.

| 대상 파일 | 조치 |
| -- | -- |
| `packages/<p>-oauth-provider/sources/configuration.ts`·`provider.ts`·`index.ts`·`provider.test.ts` | `packages/naver-oauth-provider`와 같은 형태. `OAuthProvider` 구현, 응답 zod 스키마, `create<P>AuthorizationURL`, `parse<P>UserFromResponse` |
| `workers/<p>-oauth-provider-worker/sources/index.ts` | github 워커와 같은 구조. provider 고유 부분은 §2.3.2 |
| `workers/<p>-oauth-provider-worker/tests/index.test.ts` | github 워커 테스트를 `<p>`에 맞게 옮긴다. §3의 동작마다 테스트가 있어야 한다 |

#### 2.3.1 새 provider의 환경 변수와 시크릿

| provider | 시크릿(wrangler secret put) | 워크플로 secrets 이름 |
| -- | -- | -- |
| threads | `THREADS_CLIENT_ID`(App ID), `THREADS_CLIENT_SECRET`(App Secret), `FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AXIOM_API_TOKEN`, `JWT_SECRET` | `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET`, `FRONTEND_URL` |
| tiktok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, 이하 동일 | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `FRONTEND_URL` |
| line | `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, 이하 동일 | `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `FRONTEND_URL` |
| bluesky | `BLUESKY_CLIENT_PRIVATE_JWK`(ES256 개인 키 JWK JSON, `kid` 포함), 이하 동일. client id는 시크릿이 아니라 워커 origin에서 만든다 | `BLUESKY_CLIENT_PRIVATE_JWK`, `FRONTEND_URL` |

기존 6종과 google·github처럼 `SUPABASE_URL`·`SUPABASE_SECRET_KEY`·`AXIOM_API_TOKEN`·`JWT_SECRET`은 워크플로가 넘기지 않으므로 `wrangler secret put`으로 직접 넣는다.

#### 2.3.2 provider 고유 부분

공식 문서로 확인한 값이다(2026-09-28). 레인은 구현 전에 같은 문서를 다시 열어 바뀐 것이 없는지 확인한다.

| 항목 | threads | tiktok | line |
| -- | -- | -- | -- |
| 인가 URL | `https://threads.net/oauth/authorize` — 문서에 `threads.com`도 보이므로 현재 문서 기준으로 정한다 | `https://www.tiktok.com/v2/auth/authorize/` | `https://access.line.me/oauth2/v2.1/authorize` |
| 인가 파라미터 | `client_id`, `redirect_uri`, `response_type=code`, `scope=threads_basic`, `state` | `client_key`, `scope=user.info.basic`, `response_type=code`, `redirect_uri`, `state` | `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope=profile openid email` |
| 토큰 교환 | `POST https://graph.threads.net/oauth/access_token` form: `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code` → `access_token`, `user_id` | `POST https://open.tiktokapis.com/v2/oauth/token/` form: `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri` → `open_id`, `access_token`, … | `POST https://api.line.me/oauth2/v2.1/token` form: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret` → `access_token`, `id_token` |
| 사용자 정보 | `GET https://graph.threads.net/v1.0/me?fields=id,username,name,threads_profile_picture_url` Bearer | `GET https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name` Bearer → `data.user` | `GET https://api.line.me/v2/profile` Bearer → `userId`, `displayName`, `pictureUrl`. 이메일은 `POST https://api.line.me/oauth2/v2.1/verify` form `id_token`, `client_id` → `sub`, `email`. `sub`가 `userId`와 다르면 거부 |
| 계정 식별자 | `id` | `open_id` | `userId` |
| name / picture | `name ?? username` / `threads_profile_picture_url` | `display_name` / `avatar_url` | `displayName` / `pictureUrl` |
| email | 없음 → 생략 | 없음 → 생략 | verify 응답에 있을 때만 |

**bluesky (AT Protocol OAuth, confidential client)** — 일반 OAuth와 다르다.

- 워커가 `GET /oauth-client-metadata.json`과 `GET /jwks.json`을 제공한다. `client_id`는 `${url.origin}/oauth-client-metadata.json`. 메타데이터 필수 필드: `client_id`, `client_name`, `redirect_uris`(`${origin}/callback`), `grant_types`(`authorization_code`), `response_types`(`code`), `scope`, `token_endpoint_auth_method=private_key_jwt`, `token_endpoint_auth_signing_alg=ES256`, `dpop_bound_access_tokens=true`, `application_type=web`, `jwks_uri`. 공개 키는 `BLUESKY_CLIENT_PRIVATE_JWK`에서 만든다.
- `/authorize`는 `redirect_uri` 외에 `handle`이 필요하다. 없으면 400.
- 흐름: handle → DID(`com.atproto.identity.resolveHandle`) → DID 문서 → PDS → `/.well-known/oauth-protected-resource` → 인가 서버 → `/.well-known/oauth-authorization-server`. PKCE(S256)와 로그인마다 새 DPoP ES256 키. PAR에 DPoP 증명 + `private_key_jwt` client assertion(aud = 인가 서버 issuer) + `login_hint=handle`. scope는 `atproto transition:email`. `use_dpop_nonce` 오류면 `DPoP-Nonce` 헤더로 한 번 재시도. 인가 URL은 `authorization_endpoint?client_id&request_uri`.
- 콜백은 `code`·`state`·`iss`. `iss`가 state에 저장한 issuer와 다르면 거부. 토큰 요청에 DPoP + client assertion + `code_verifier`. 응답 `sub`가 state의 DID와 다르면 거부.
- 사용자 정보: `GET <PDS>/xrpc/com.atproto.server.getSession`, `Authorization: DPoP <access_token>` + DPoP 증명(`ath` 포함) → `did`, `handle`, `email`(있을 때만). 계정 식별자는 DID, name은 handle, picture는 생략.
- state에 저장할 것: `redirectURI`, `linkTicket`, `codeVerifier`, DPoP 개인 키 JWK, `did`, `pdsURL`, 인가 서버 issuer, 마지막 `DPoP-Nonce`.
- 구현 순서: 레인 S가 넣어 둔 `@atproto/oauth-client`와 `@atproto/jwk-webcrypto`가 Workers 런타임에서 도는지 먼저 확인한다. 돌면 그것으로, 안 돌면 WebCrypto로 직접 구현한다. 직접 구현했으면 두 패키지가 미사용이라고 notes에 적는다(제거는 별도 `pnpm remove`).
- 테스트는 fetch를 대체해 resolveHandle·DID 문서·PRM·AS 메타데이터·PAR·토큰·getSession을 흉내 낸다. `handle` 없음 400, `iss` 불일치 거부, `sub` 불일치 거부, nonce 재시도가 각각 테스트로 있어야 한다.

## 3. 워커 계약 (전문) — 워커 10종 공통

레인 U·N은 이 계약을 그대로 만족해야 하고, 레인 C는 이 계약으로 판정한다. 기준은 github 워커의 현재 동작이다.

**환경 필드**

```ts
interface Environment extends BaseEnvironment {
  // provider 고유 필드 (§2.3.1 또는 기존 워커의 것)
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  AXIOM_API_TOKEN: string;
  AXIOM_DATASET: string;
  JWT_SECRET?: string;
  AUDIO_UNDERVIEW_OAUTH_STATE: KVNamespace;
}
```

**connector에서 가져다 쓰는 것** — 전부 이미 export되어 있다.

```ts
import {
  accountRouteRequiresBody,
  consumeLinkTicket,
  createSessionTokenPayload,
  createSupabaseClient,
  handleAccountRoute,
  isAllowedRedirectURI,
  isValidOAuthState,
  parseAllowedOrigins,
  resolveLoginAccount,
  stashLinkCode,
} from '@audio-underview/supabase-connector';
import {
  type BaseEnvironment,
  type ResponseContext,
  createCORSHeaders,
  createOAuthWorkerHandler,
  errorResponse,
  jsonResponse,
  validateCallbackParameters,
  verifyState,
  redirectToFrontendWithError,
  signJWT,
  verifyJWT,
} from '@audio-underview/worker-tools';
```

**동작**

1. `GET /authorize?redirect_uri=…` — `redirect_uri`가 없으면 400. origin이 `parseAllowedOrigins(ALLOWED_ORIGINS, FRONTEND_URL)`에 없으면 400. `link_ticket`이 있으면 연결 흐름. state는 `generateState()` 값이고 KV에 `{ redirectURI, linkTicket }` JSON으로 5분 저장한다.
2. `GET /callback` — `state`가 `isValidOAuthState`를 통과하지 못하면 KV를 만지기 전에 거부한다. 저장된 `redirectURI`의 origin을 다시 검사한다. 이전 형식(문자열만 저장된 state)도 읽는다.
3. 로그인 완료 시 계정 결정은 `resolveLoginAccount`로 한다. Supabase가 응답하면 그 UUID, 실패하면 KV 저장 UUID, 둘 다 없으면 `account_unavailable` 오류로 프런트엔드에 보낸다.
4. `JWT_SECRET`이 있으면 `signJWT(createSessionTokenPayload({ userUUID, provider }), secret)`로 세션 토큰을 만들어 리다이렉트에 `session_token`을 추가한다. 없으면 경고 로그만 남기고 토큰 없이 진행한다. 500을 내지 않는다.
5. 리다이렉트 파라미터: `user`(JSON), `access_token`, `uuid`, 그리고 있을 때만 `session_token`. `user.email`은 provider가 준 값만 넣는다.
6. 연결 흐름의 콜백은 계정을 쓰지 않고 `stashLinkCode`로 저장한 뒤 `link_code`를 돌려보낸다.
7. 보호 라우트 `GET /accounts`, `DELETE /accounts/…`, `POST /link-tickets`, `POST /accounts/link-confirm`은 `handleAccountRoute`에 위임한다. 토큰 없으면 401, `JWT_SECRET` 없으면 503.
8. `OPTIONS`는 `Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type`.
9. 기본 export는 `instrumentWorker(handler, …)`로 감싼다.

## 4. 배포 후 동작

- 웹은 google·github만 호출하므로 사용자에게 보이는 변화는 없다. 워커 10종은 배포되어도 웹이 연결되기 전까지 호출되지 않는다.
- 기존 6종 워커는 배포 즉시 `redirect_uri` 허용 목록을 강제한다. 지금은 존재 여부만 본다.

## 5. 완전 동작 판정 절차

1. `pnpm --filter @audio-underview/sign-provider typecheck` / `test`.
2. 워커 10종 각각 `pnpm --filter @audio-underview/<p>-oauth-provider-worker typecheck` / `test`. 패키지 4종 각각 typecheck / test.
3. 루트 `pnpm typecheck`와 `pnpm test` — web·crawler-manager·scheduler-manager 포함 전부 통과. 이 단위는 공용 열거형을 넓히므로 다른 워크스페이스가 깨지면 오류다.
4. 사람: Supabase 프로덕션 DB에 마이그레이션 009 적용.
5. 사람: provider 콘솔에 앱 등록, 워커 `/callback` 주소 등록, 시크릿 발급. Bluesky는 키 생성(§10).
6. 사람: 워커 10종에 시크릿 투입(§2.3.1). `JWT_SECRET`은 google·github와 같은 값.
7. 사용자 승인 후 배포.
8. `curl "https://<워커>/authorize?redirect_uri=https://example.invalid/callback"` → 400. 토큰 없이 `/accounts` → 401.
9. 실브라우저 로그인은 웹 연결(별건) 뒤에.

## 6. 추적 목록 (초기값)

| 항목 | 상태 | 원인 | 재접속 단계 |
| -- | -- | -- | -- |
| 웹에서 6종·4종 로그인 시작 | 미접속 | 웹은 google·github 워커 주소만 읽는다 | 웹 이식(별건) |
| crawler-manager 토큰 교환 | 미접속 | `provider`를 google·github로 고정 | 3단계(세션 JWT 통일) |
| Bluesky handle 입력 화면 | 미접속 | `/authorize`가 `handle`을 요구하는데 웹에 입력이 없다 | 웹 이식(별건) |
| Threads 일반 사용자 로그인 | 외부 대기 | Meta 앱 심사 통과 필요 | 사람 |
| LINE 이메일 | 외부 대기 | 콘솔에서 이메일 권한 신청·승인 필요 | 사람 |
| X 로그인 운영 | 외부 대기 | X API는 종량제뿐이라 크레딧이 떨어지면 로그인이 멈춘다 | 사람 |

## 7. 레인 분해

- **레인 S** — Sonnet 5. 순차, 가장 먼저. §2.1.
- **레인 U-apple … U-naver** — Opus 5.5. 6개 병렬. §2.2. 각자 자기 워커 디렉터리만.
- **레인 N-threads … N-bluesky** — Opus 5.5. 4개 병렬(U와 동시). §2.3. 각자 자기 패키지·워커만.
- **레인 C(REFUTE)** — Opus 5.5, effort high. 코드 수정 없음. §8 전 항목을 실제 명령으로 확인해 CONFIRMED/REFUTED.
- **수정 라운드** — HIGH만. 이후 재검증.

## 8. REFUTE 대상

1. `workers/google-oauth-provider-worker`·`workers/github-oauth-provider-worker`·`packages/supabase-connector/sources`·`workers/tools`·`packages/axiom-logger`·`packages/logger`가 바뀜. 단 `workers/tools/sources/types.ts`의 `OAuthProvider` 타입 정의와 그 import 한 줄은 §11.1의 예외다. `packages/sign-provider`는 §2.1의 3파일 외가 바뀜.
2. 루트 `pnpm typecheck` 또는 `pnpm test`가 실패함(web·crawler-manager·scheduler-manager 포함).
3. 워커 10종 중 하나라도: 테스트 실패, 또는 §3의 동작 1·2·4·7(허용 밖 `redirect_uri` 400 / 잘못된 state 거부 / `JWT_SECRET` 미설정 시 토큰 없이 진행·500 아님 / 토큰 없이 `/accounts` 401 / `JWT_SECRET` 설정 시 `session_token` 포함)을 검증하는 테스트가 없음.
4. 기존 6종의 provider 고유 동작이 사라짐 — apple `form_post` POST 콜백, kakao 선택적 secret, microsoft tenant, naver 중첩 응답.
5. 공용 목록 불일치 — 열거형 15개, 표시 설정 키 15개, 마이그레이션 009의 `ADD VALUE` 5개, 배포 워크플로 job 15개·inputs 15개(deploy_all 제외). worker-tools의 `OAuthProvider`가 공용 목록과 다른 값 집합이면 불일치다.
6. 새 워커 4종 `wrangler.toml`이 이름 규칙·KV binding·`ALLOWED_ORIGINS`에서 기존과 다름, 또는 시크릿 값이 들어 있음.
7. `package.json`·`pnpm-lock.yaml` 변경이 §2.1의 범위(6종 의존성 추가, 패키지 4종·워커 4종 신규, bluesky의 atproto 2개) 밖에 있음.
8. 실제 키·토큰 문자열이 소스·설정·테스트에 들어 있음(테스트 더미 값 제외).
9. email을 주지 않는 provider(threads·tiktok)에서 email을 지어냄.
10. bluesky 클라이언트 메타데이터에 §2.3.2의 필수 필드가 빠짐, 또는 `iss`·`sub` 불일치 거부 테스트가 없음.
11. 워커 13종(6종 교체 + 7종 신규) 중 `wrangler.toml`에 `compatibility_flags = ["nodejs_compat"]`가 없는 것이 있음.
12. provider 워커 소스에 `as string as` 같은 provider 타입 cast가 남아 있음.
13. x 워커: 인가·토큰·사용자 정보 주소가 `x.com`·`api.x.com`이 아님, PKCE `code_verifier`를 state에 저장하지 않거나 토큰 요청에 보내지 않음, 토큰 요청이 Basic 인증 헤더를 쓰지 않음, `confirmed_email`이 없을 때 email을 지어냄. 각각을 검증하는 테스트가 없음.
14. twitch 워커: Get Users 요청에 `Client-Id` 헤더가 없음, 또는 email이 없을 때 email을 지어냄.

## 9. 비범위

- 웹의 로그인 시작·버튼 연결·`session_token` 소비·Bluesky handle 입력.
- crawler-manager 토큰 교환의 provider 확장.
- 세션 수명 연장·갱신, passkey.
- bluesky 워커의 미사용 `@atproto/*` 의존성 제거(별도 `pnpm remove`).

## 10. 사람이 준비할 것

- provider 콘솔: Threads(Meta 앱, `threads_basic` 심사), TikTok(Login Kit 앱), LINE(Login 채널, 이메일 권한 신청), Bluesky(콘솔 없음 — 메타데이터 URL이 등록을 대신한다).
- Bluesky 개인 키 생성 후 `wrangler secret put BLUESKY_CLIENT_PRIVATE_JWK`:
  ```bash
  node -e "crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']).then(async k=>{const j=await crypto.subtle.exportKey('jwk',k.privateKey);j.kid=crypto.randomUUID();j.alg='ES256';j.use='sig';console.log(JSON.stringify(j))})"
  ```
  출력은 화면에만 뜨므로 곧바로 시크릿에 넣고 기록으로 남기지 않는다.
- Supabase 프로덕션 DB에 마이그레이션 009 적용.
- 워커 13종 시크릿 투입과 배포 승인.
- LinkedIn: 앱을 LinkedIn 페이지에 연결하고 페이지 관리자가 인증, Products 탭에서 "Sign In with LinkedIn using OpenID Connect" 추가. 사용자 식별자가 앱마다 다르게 발급되므로 앱을 새로 만들지 않는다.
- X: 개발자 콘솔에서 크레딧 구매, OAuth 2.0 confidential client로 앱 설정.
- Twitch: 개발자 계정 2단계 인증, 앱 등록.

## 11. 추가 범위 — linkedin·x·twitch와 공용 타입 정리 (2026-09-28)

1차 실행 결과: 워커 10종 중 9종 GREEN, LINE 워커만 worker-tools의 닫힌 provider 타입 때문에 typecheck 실패. 이 절은 그 정리와 워커 3종 추가를 다룬다. 1차 산출물(작업 트리)에 이어서 작업한다.

### 11.1 레인 S2 — 공용 정리와 골격 (Sonnet 5, 순차, 가장 먼저)

| 대상 | 조치 |
| -- | -- |
| `workers/tools/sources/types.ts` | `OAuthProvider` 정의를 `import type { OAuthProviderID } from '@audio-underview/sign-provider';` + `export type OAuthProvider = OAuthProviderID;`로 바꾼다. 이름 `OAuthProvider`는 유지한다(쓰는 곳 무변경). worker-tools는 이미 sign-provider에 의존한다 |
| `packages/sign-provider/sources/types/user.ts`·`user.test.ts` | `'twitch'` 추가(열거형 끝) |
| `packages/sign-provider/sources/providers/configurations.ts` | twitch: displayName `Twitch`, backgroundColor `#9146FF`, textColor `#FFFFFF`, iconType `fontawesome`, iconName `faTwitch` |
| `packages/supabase-connector/migrations/009_add_login_providers.sql` | `ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'twitch';` 한 줄 추가, 첫 줄 주석에 twitch 추가 |
| `.github/workflows/deploy-oauth-workers.yml` | inputs·job에 `linkedin`·`x`·`twitch` 추가. 시크릿 이름은 §11.3 |
| `packages/twitch-oauth-provider/` | naver 패키지의 `package.json`·`tsconfig.json`·`vitest.config.ts` 복사, `name`만 변경 |
| `workers/linkedin-…`, `workers/x-…`, `workers/twitch-oauth-provider-worker/` | 레인 S가 threads 워커에 한 것과 같은 방식으로 `package.json`·`tsconfig.json`·`wrangler.toml`·`vitest.config.ts` 골격. `wrangler.toml`에 `compatibility_flags = ["nodejs_compat"]`와 `AXIOM_DATASET` 포함. 시크릿 이름은 §11.3 |
| `workers/line-oauth-provider-worker/wrangler.toml` | `compatibility_date` 바로 아래에 `compatibility_flags = ["nodejs_compat"]` 한 줄 |
| threads·tiktok·bluesky 워커 `sources/index.ts` | provider 타입 cast 제거(`PROVIDER as string as …` → `PROVIDER`, bluesky의 `HEALTH_CHECK_PROVIDER` 상수 제거 후 `PROVIDER` 사용), 쓰지 않게 된 타입 import 제거. 그 밖은 건드리지 않는다 |
| 마지막 | 루트에서 `pnpm install` |

### 11.2 레인 N-linkedin, N-x, N-twitch (Opus 5.5, 3개 병렬)

파일 소유: `packages/<p>-oauth-provider/sources/**`(linkedin은 필요할 때만), `workers/<p>-oauth-provider-worker/sources/**`·`tests/**`. 워커 구조는 §3 계약과 github 워커를 따른다.

| 항목 | linkedin | x | twitch |
| -- | -- | -- | -- |
| 패키지 | 기존 패키지 유지. 현재 공식 방식과 일치한다 | 고친다: 주소를 `https://x.com/i/oauth2/authorize`, `https://api.x.com/2/oauth2/token`, `https://api.x.com/2/oauth2/revoke`, `https://api.x.com/2/users/me`로. 기본 scope `users.read tweet.read users.email`. 응답 스키마에 `confirmed_email` 추가, email은 그 값이 있을 때만 | 신규 |
| 인가 | `https://www.linkedin.com/oauth/v2/authorization`, scope `openid profile email` | PKCE S256 필수. `code_verifier`는 state JSON에 저장 | `https://id.twitch.tv/oauth2/authorize`, scope `user:read:email` |
| 토큰 교환 | `POST https://www.linkedin.com/oauth/v2/accessToken` form: `grant_type`, `code`, `redirect_uri`, `client_id`, `client_secret` | `POST https://api.x.com/2/oauth2/token` form: `code`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier`. 헤더 `Authorization: Basic base64(client_id:client_secret)` | `POST https://id.twitch.tv/oauth2/token` form: `client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri` |
| 사용자 정보 | `GET https://api.linkedin.com/v2/userinfo` Bearer → `sub`, `name`, `given_name`, `picture`, `email`(선택) | `GET https://api.x.com/2/users/me?user.fields=profile_image_url,confirmed_email` Bearer → `data.id`, `data.name`, `data.username`, `data.profile_image_url`, `data.confirmed_email` | `GET https://api.twitch.tv/helix/users` 헤더 `Authorization: Bearer`, `Client-Id` → `data[0].id`, `login`, `display_name`, `profile_image_url`, `email` |
| 계정 식별자 | `sub` | `data.id` | `data[0].id` |
| name / picture | `name ?? given_name` / `picture` | `name` / `profile_image_url` | `display_name ?? login` / `profile_image_url` |
| email | 응답에 있을 때만 | `confirmed_email`이 있을 때만 | 응답에 있을 때만(미인증 이메일은 null) |

### 11.3 시크릿 이름

| provider | 시크릿 | 워크플로 secrets 이름 |
| -- | -- | -- |
| linkedin | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, 공통(`FRONTEND_URL`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AXIOM_API_TOKEN`, `JWT_SECRET`) | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `FRONTEND_URL` |
| x | `X_CLIENT_ID`, `X_CLIENT_SECRET`, 공통 | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `FRONTEND_URL` |
| twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, 공통 | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `FRONTEND_URL` |

### 11.4 검증

레인 C는 §8의 14항목 전부를 워커 13종 기준으로 판정한다. 1차 실행에서 GREEN이던 항목도 다시 확인한다.
