# 01 로그인 워커 교체 — 세션 JWT · 계정 연결 · redirect_uri 정책 (0단계)

2026-09-14. 상태: 설계 확정, 메인 세션 위임 대기. 전제 규약: `00-migration-plan.md` §8. 출처 커밋 `8bdfc7d`(브랜치 `worktree-prototype-scaffold`).

Linear: **TES-100**(부모, 마일스톤 "프로토타입 이관") — 하위 TES-101(레인 A) · TES-102(레인 B) · TES-103(JWT_SECRET 프로비저닝·배포) · TES-104(실환경 판정 10단계). 커밋·PR 제목에 `[TES-100]`, 브랜치 `feature/login-workers-migration`. 참고 설계: Linear 프로젝트 "Audio Underview Prototype" 문서 "2026-08-12 account linking — 한 계정에 소셜 로그인 여러 개".

## 0. 결정사항

- 프로덕션의 google/github OAuth 워커 두 개를 프로토타입 판으로 **교체**하고, 그 워커가 의존하는 connector 모듈 4개를 메인 `packages/supabase-connector`에 **추가**한다.
- 사용자 눈에 보이는 로그인 절차는 바뀌지 않는다. 바뀌는 것은 워커 내부(세션 JWT 발급, 계정 resolve 경로, `redirect_uri` 허용목록 강제)와 워커에 새로 생기는 보호 라우트 4개다.
- 나머지 프로바이더 워커 8종(apple·discord·facebook·kakao·microsoft·naver·linkedin·x)은 프로토타입에 포크가 없으므로 손대지 않는다.
- `newscast-*`·`logger-prototype`·`worker-tools-prototype`는 이 단위에 들어오지 않는다(00 §4 (d)(e)).

## 1. 단위의 경계

**들어오는 것**

| 대상 | 메인 대응물 | 내용 | 크기 |
| -- | -- | -- | -- |
| `packages/supabase-connector` | 있음 → 추가 | 신규 모듈 4개 + 테스트 4개, `test-helpers.ts` 추가분, `index.ts` export 추가 | 1,116줄 + 테스트 94 케이스 |
| `workers/github-oauth-provider-worker` | 있음 → 교체 | `sources/index.ts`, `tests/index.test.ts` | 약 360줄 diff, 테스트 53 케이스 |
| `workers/google-oauth-provider-worker` | 있음 → 교체 | 위와 동일 | 약 360줄 diff, 테스트 52 케이스 |

**안 들어오는 것**

- connector `sources/client.ts`의 `db: { schema: 'prototype' as unknown as 'public' }` 3줄 — 메인은 `public`.
- 워커 `wrangler.toml`의 `name`·KV `id`·`ALLOWED_ORIGINS`·`FRONTEND_URL` 값 — 메인 값 유지.
- `packages/worker-tools-prototype` — 메인 `worker-tools`의 `jwt.ts`가 동일하고 `signJWT`·`verifyJWT`를 export한다.
- 웹(`applications/web`) — 3단계.

**의존성 변화: 없음.** connector는 의존 차이가 없고, 두 워커는 이미 `@audio-underview/supabase-connector`·`@audio-underview/worker-tools`를 의존 목록에 갖고 있다. `pnpm add` 없이 `pnpm install`만.

## 2. 파일 단위 지시

### 2.1 `packages/supabase-connector` (레인 A)

| 대상 파일 | 조치 | 출처(`git show 8bdfc7d:<경로>`) |
| -- | -- | -- |
| `sources/account-linking.ts` | 신규 | `packages/supabase-connector-prototype/sources/account-linking.ts` |
| `sources/account-routes.ts` | 신규 | `…/account-routes.ts` |
| `sources/session-tokens.ts` | 신규. 17행 주석의 `worker-tools-prototype` → `worker-tools` | `…/session-tokens.ts` |
| `sources/oauth-request-policy.ts` | 신규 | `…/oauth-request-policy.ts` |
| `sources/account-linking.test.ts` `account-routes.test.ts` `session-tokens.test.ts` `oauth-request-policy.test.ts` | 신규 | 같은 이름 |
| `sources/test-helpers.ts` | 프로토타입 판으로 교체 — 기존 `setupTracerMock` 유지, `createFakeSupabaseClient`·`createMemoryAccountStateStorage` 추가. **순수 추가** | `…/test-helpers.ts` |
| `sources/index.ts` | 프로토타입 판으로 교체 — 73줄 전부 export 추가. **순수 추가** (§3 전문) | `…/index.ts` |
| `sources/client.ts` | **손대지 않음** | — |
| `sources/types/`, `migrations/`, `package.json` | 손대지 않음(동일) | — |

신규 모듈의 의존은 메인에 이미 있는 `@audio-underview/sign-provider`·`@audio-underview/axiom-logger/tracers`·`@supabase/supabase-js`와 connector 내부 `./accounts.ts`·`./types/index.ts`뿐이다.

### 2.2 `workers/github-oauth-provider-worker`, `workers/google-oauth-provider-worker` (레인 B)

| 대상 파일 | 조치 | 출처 |
| -- | -- | -- |
| `sources/index.ts` | 프로토타입 판으로 교체 후 import 2줄 수정: `'@audio-underview/supabase-connector-prototype'` → `'@audio-underview/supabase-connector'`, `'@audio-underview/worker-tools-prototype'` → `'@audio-underview/worker-tools'`. 주석(github 기준 550행 부근 "worker-tools (non-prototype) …")의 prototype 언급 정리 | `workers/<provider>-oauth-provider-worker-prototype/sources/index.ts` |
| `tests/index.test.ts` | 프로토타입 판으로 교체, 같은 import 치환 | `…/tests/index.test.ts` |
| `wrangler.toml` | **손대지 않음.** KV binding 이름 `AUDIO_UNDERVIEW_OAUTH_STATE`는 양쪽 동일. 메인 `ALLOWED_ORIGINS`에 프로덕션 origin이 이미 있다. `FRONTEND_URL`은 메인에서 시크릿이므로 프로토타입 toml의 `[vars] FRONTEND_URL` 줄을 가져오지 않는다 | — |
| `package.json` | 손대지 않음 | — |

`Environment` 변화는 `JWT_SECRET?: string` 추가(선택 필드) 하나다. 미설정이면 워커는 경고 로그를 남기고 세션 토큰 없이 이전 동작으로 진행한다 — 완료 기준(§5) 미달이므로 배포 전 반드시 설정한다.

### 2.3 복사 후 확인

```bash
grep -rn -i prototype packages/supabase-connector workers/github-oauth-provider-worker workers/google-oauth-provider-worker   # 0건
pnpm install
```

## 3. 레인 간 계약 — connector가 export해야 하는 것 (전문)

레인 B는 이 목록을 전제로 레인 A와 병렬 진행한다. 메인 `index.ts`에 아래 블록이 **추가**되고, 기존 export는 하나도 바뀌지 않는다.

```ts
export type {
  SessionTokenClaims,
  SessionTokenPayload,
  SessionTokenVerifier,
  CreateSessionTokenPayloadOptions,
} from './session-tokens.ts';
export {
  SESSION_TOKEN_LIFETIME_SECONDS,
  createSessionTokenPayload,
  readBearerToken,
  toSessionTokenClaims,
  authenticateSessionRequest,
} from './session-tokens.ts';
export type {
  AccountStateStorage,
  LoginAccountResolution,
  ResolveLoginAccountOptions,
  LinkProviderOutcome,
  LinkTicket,
  LinkTicketBinding,
  StashedProviderIdentity,
  ConfirmAccountLinkOptions,
  ConfirmAccountLinkResult,
  LinkedAccountSummary,
  UnlinkProviderResult,
  UnlinkProviderAccountOptions,
} from './account-linking.ts';
export {
  LINK_TICKET_LIFETIME_SECONDS,
  LINK_CODE_LIFETIME_SECONDS,
  linkTicketStorageKey,
  linkCodeStorageKey,
  accountCacheStorageKey,
  createLinkTicket,
  consumeLinkTicket,
  stashLinkCode,
  consumeLinkCode,
  confirmAccountLink,
  rememberAccountUUID,
  recallAccountUUID,
  forgetAccountUUID,
  resolveLoginAccount,
  linkProviderAccount,
  listLinkedAccounts,
  unlinkProviderAccount,
} from './account-linking.ts';
export {
  isValidOAuthState,
  parseAllowedOrigins,
  isAllowedRedirectURI,
} from './oauth-request-policy.ts';
export type {
  AccountRouteRequest,
  AccountRouteDependencies,
  AccountRouteResult,
} from './account-routes.ts';
export {
  ACCOUNTS_PATHNAME,
  ACCOUNTS_PATHNAME_PREFIX,
  ACCOUNT_LINK_CONFIRM_PATHNAME,
  LINK_TICKETS_PATHNAME,
  accountRouteRequiresBody,
  isAccountRoutePathname,
  handleAccountRoute,
} from './account-routes.ts';
```

## 4. 배포 후 프로덕션 동작

**바뀌는 것 (워커 내부)**

1. callback이 자체 세션 JWT(HS256, `sub` = Supabase 계정 UUID, 수명 `SESSION_TOKEN_LIFETIME_SECONDS` = 86,400)를 발급해 리다이렉트에 `session_token` 파라미터를 **추가**한다.
2. 로그인 시 계정 resolve가 `resolveLoginAccount`(account-linking) 경로로 바뀐다. 이메일 자동 병합은 없고 명시적 두 단계 handshake(`nonce` + `link_code` + 세션 JWT)로만 연결되므로 기존 사용자 데이터에 영향이 없다.
3. `/authorize`·`/callback`이 `ALLOWED_ORIGINS` 밖 `redirect_uri`를 거부한다(지금 메인은 존재 여부만 확인).
4. 보호 라우트 4개가 생긴다: `GET /accounts`, `/accounts/…`(`DELETE`로 연결 해제), `POST /link-tickets`, `POST /accounts/link-confirm`. 전부 Bearer 세션 JWT 필요.

**바뀌지 않는 것**

- 메인 웹 로그인. callback이 `user`·`access_token`·`uuid`를 그대로 보내고, 메인 웹은 `session_token`을 무시한 채 raw `access_token`을 crawler-manager `/authentication/token`에 넘겨 자기 JWT를 받는다.
- 프로바이더 워커 8종, crawler-manager, scheduler-manager, 웹.

## 5. 완전 동작 판정 절차

1. `pnpm --filter @audio-underview/supabase-connector typecheck` / `test` — 신규 94 케이스 + 기존 전부 그린.
2. `pnpm --filter @audio-underview/github-oauth-provider-worker typecheck` / `test`, google 동일 — 53·52 케이스 그린.
3. 루트 `pnpm typecheck` — 이 단위는 **순수 추가**이므로 다른 워크스페이스가 깨지면 이관 오류다(추적 목록이 아니라 수정 대상).
4. 사람: 두 워커에 `wrangler secret put JWT_SECRET`(같은 값). 값은 보관한다 — 2단계 파이프라인 워커에 **바이트 동일**한 값이 필요하다.
5. 사용자 승인 후 두 워커 배포.
6. 실브라우저: 프로덕션 웹에서 GitHub 로그인 → 기존과 같이 홈 도달(불변 확인).
7. 세션 JWT 확보: 개발자 도구 네트워크 탭에서 `/callback` 302의 `Location`에 있는 `session_token`을 복사한다(로컬 웹 `http://localhost:5173`도 허용 origin이라 그쪽으로 받아도 된다).
8. `curl -H "Authorization: Bearer <session_token>" https://<github 워커>/accounts` → 200, 방금 로그인한 provider가 목록에 있다. 같은 토큰으로 google 워커의 `/accounts`도 200(같은 `JWT_SECRET`이므로).
9. `curl "https://<워커>/authorize?redirect_uri=https://example.invalid/callback"` → 4xx.
10. 토큰 없이 `/accounts` → 401.

10개 전부 통과가 완료다. 완료 보고에 §6 추적 목록을 첨부한다.

## 6. 추적 목록 (초기값)

| 항목 | 상태 | 원인 | 재접속 단계 |
| -- | -- | -- | -- |
| 세션 JWT를 쓰는 웹 화면 | 미접속 | 메인 웹은 `access_token`만 읽는다 | 3 |
| 계정 연결 UI(`/link-tickets` → `/authorize` → `/accounts/link-confirm` 흐름) | 미접속 | 메인 웹에 화면이 없다 | 3 |
| JWT 발급자 2곳 공존(OAuth 워커 세션 JWT / crawler-manager exchange JWT) | 미접속 | 3단계에서 하나로 통일 | 3 |
| 프로바이더 워커 8종 | 변화 없음 | connector 변경이 순수 추가 | — |

## 7. 레인 분해

- **레인 A** — 파일 소유: `packages/supabase-connector/**`. §2.1.
- **레인 B** — 파일 소유: `workers/github-oauth-provider-worker/**`, `workers/google-oauth-provider-worker/**`. §2.2. §3 계약을 전제로 A와 병렬 진행. 통합 typecheck·테스트는 A 완료 후.
- **레인 C(REFUTE)** — 코드 수정 없음. §8 전 항목을 실제 명령으로 확인해 CONFIRMED/REFUTED로 보고.

## 8. REFUTE 대상

1. 세 디렉터리 어디든 `prototype` 문자열 잔존(import·주석 포함).
2. connector `client.ts`가 바뀌었거나 `schema: 'prototype'`이 들어옴.
3. 메인 connector의 기존 export가 하나라도 사라지거나 시그니처가 바뀜 — 프로바이더 워커 8종·crawler-manager·scheduler-manager·web의 typecheck로 확인.
4. 두 워커의 `wrangler.toml`이 바뀜(`name`·KV `id`·`ALLOWED_ORIGINS`·`FRONTEND_URL` 어느 것이든).
5. 워커 테스트나 소스가 `-prototype` 패키지를 import.
6. `JWT_SECRET` 미설정 시 워커가 500을 내는지 — 프로토타입 동작(경고 로그 + 토큰 없이 진행)이 보존돼야 한다.
7. `ALLOWED_ORIGINS`에 프로덕션 origin이 빠져 `/authorize`가 프로덕션 웹을 거부하는 설정 오류.
8. `package.json`이 직접 편집됨.

## 9. 비범위

- 세션 수명 24시간 연장·갱신(00 §7).
- 웹의 `session_token` 소비, 계정 연결 UI(3단계).
- 나머지 프로바이더 8종 워커에 세션 JWT 발급 추가 — 프로토타입에도 없으므로 이관 대상이 아니다.
- crawler-manager·scheduler-manager 인증을 세션 JWT로 통일(3단계).
