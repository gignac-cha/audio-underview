# Architecture — audio-underview 완전 재작성 (2026-07)

> 근거 문서: `documents/specifications/` 5개 (data-model, authentication-flow, crawler-scheduler-domain, web-experience, infrastructure-deployment) + `documents/full-rewrite-analysis.md`

## 1. 목표와 원칙

> **정정 (2026-07-07)**: 초기 설계는 "Supabase 스키마를 그대로 보존"을 제약으로 삼았으나,
> 외부 데이터는 재생성 가능하므로 **DB 스키마도 자유롭게 개선해도 된다**. 아래 원칙 1에서
> 스키마 보존 항목을 완화한다 — 기존 migration을 계승하되, 더 나은 구조(RLS, 정규화,
> 제약 강화 등)로 바꾸는 것이 허용된다. 유지가 필요한 것은 "형식적 계약"(에러 응답 형식,
> 배포 파이프라인 형태)뿐이다. §6·§10(ADR-7)의 스키마 관련 결정도 이 완화를 따른다.

1. **계약 보존** — 외부 세계와 맞닿은 *형식*은 유지한다:
   - 에러 응답 형식 `{ error, error_description }`
   - 배포 파이프라인 형태 (GitHub Actions, Cloudflare Workers/Pages, AWS Lambda)
   - Supabase 스키마: 기존 migration을 출발점으로 계승하되 **개선 가능**(강제 보존 아님).
     외부 데이터 재생성이 가능하므로 테이블/제약/RLS를 더 나은 형태로 바꿔도 된다.
2. **보안 우선** — 스펙에서 발견된 이슈 전부 해소 (§9 매핑 테이블)
3. **구조 최소화** — 31 패키지 → **12 패키지** (OAuth per-provider 반복 제거)
4. **무빌드 TypeScript** — 패키지는 빌드 없이 `sources/index.ts`를 직접 노출. 소비자(wrangler, Vite, Node 25, Vitest)가 TS를 직접 소비. 빌드는 배포 대상(web, Lambda function)에만 존재
5. **CLAUDE.md 규약** — 무약어/복수형 네이밍, `.ts` import 확장자, `??`, `pnpm init`/`pnpm install`
6. **테스트는 내부에서 완결** — 외부 서비스(Supabase, OAuth provider, Axiom)는 전부 mock. 네트워크 없는 CI

## 2. 시스템 개요

```
┌──────────────────────────┐
│  applications/web        │  React 19 + Vite (Cloudflare Pages)
└───────┬──────────────────┘
        │ Bearer JWT (access token)
        ▼
┌──────────────────────────┬──────────────────────────┬────────────────────────────┐
│ authentication-worker    │ crawler-manager-worker   │ scheduler-manager-worker   │
│ (Cloudflare Worker)      │ (Cloudflare Worker)      │ (Cloudflare Worker)        │
│ OAuth 10 providers       │ crawlers CRUD            │ schedulers/stages/runs     │
│ + token issue/refresh    │                          │ + scheduled handler (flag) │
└───────┬──────────────────┴────────┬─────────────────┴──────────┬─────────────────┘
        │ KV (state/code/refresh)   │ Supabase REST              │ service call
        ▼                           ▼                            ▼
   Cloudflare KV              Supabase Postgres         crawler-code-runner-function
                                                        (AWS Lambda, node:vm sandbox)
```

## 3. Workspace 구조 (31 → 12)

| 신규 | 흡수하는 기존 패키지 | 역할 |
|------|---------------------|------|
| `applications/web` | web | React SPA |
| `packages/schemas` | (신규 — hand-rolled 검증 대체) | 전 API 계약의 zod 스키마. web ↔ workers 단일 진실 |
| `packages/logger` | logger, axiom-logger | 구조화 로거 + transport (console/Axiom) |
| `packages/database-connector` | supabase-connector | 테이블별 repository, 타입 안전 Supabase REST 접근 |
| `packages/authentication-core` | sign-provider | OAuth 플로우 엔진 (state/PKCE/nonce, KV), JWT 발급/검증, provider strategy 인터페이스 |
| `packages/authentication-providers` | *-oauth-provider ×10 | provider strategy 10개 (파일 10개, 패키지 1개) |
| `packages/worker-foundation` | worker-tools, function-tools | 라우터, CORS/인증/에러 middleware, 응답 헬퍼, 환경 파싱 |
| `workers/authentication-worker` | *-oauth-provider-worker ×8 | 단일 OAuth worker `/providers/:provider/*` + `/tokens` |
| `workers/crawler-manager-worker` | 동명 | 유지 (재작성) |
| `workers/scheduler-manager-worker` | 동명 | 유지 (재작성) + scheduled handler |
| `functions/crawler-code-runner-function` | 동명 + crawler-code-runner-worker | 사용자 코드 실행 (Lambda 단일화) |
| `tools/environment-generator` | 동명 | 1Password → .env 생성 (재작성) |

삭제: OAuth packages 10개 + OAuth workers 8개 + crawler-code-runner-worker + worker-tools + function-tools + logger/axiom-logger 분리 구조 → 위로 통합.

## 4. 인증 아키텍처

### 4.1 플로우 (신규 — authorization code 중계 방식)

```
1. web: GET  {AUTH}/providers/{provider}/authorize?redirect_uri=...
         → 302 provider (state KV 저장, TTL 300s, PKCE verifier/nonce 동봉)
2. provider → GET|POST {AUTH}/providers/{provider}/callback
         → state 검증 → token exchange (+PKCE) → id_token JWKS 서명 검증/nonce 검증
         → 사용자 정규화 → users/accounts upsert (트랜잭션 RPC)
         → 일회용 authorization code 발급 (KV, TTL 60s)
         → 302 web /authentication/callback?code=...        ← URL에 토큰 없음
3. web: POST {AUTH}/tokens { grant_type: "authorization_code", code }
         → { access_token(JWT, 1h), refresh_token(불투명, 30d, KV) }
4. web: POST {AUTH}/tokens { grant_type: "refresh_token", refresh_token }
         → rotation (기존 무효화 + 재사용 감지 시 세션 전체 폐기)
```

### 4.2 Provider Strategy

```typescript
interface OAuthProviderStrategy {
  readonly name: ProviderName;
  readonly capabilities: { pkce: boolean; nonce: boolean; identitySource: 'idToken' | 'userInfoAPI' };
  buildAuthorizationURL(parameters: AuthorizationParameters): URL;
  exchangeCode(parameters: CodeExchangeParameters): Promise<TokenResponse>;
  fetchUser(tokens: TokenResponse): Promise<NormalizedUser>;   // email nullable (x, naver 대응)
}
```

- provider별 특이사항 보존: apple(ES256 client_secret 생성, form_post), naver(HTML form 응답 아님 — 표준 302로 통일 가능, 스펙 확인됨), microsoft(tenant 템플릿), facebook/kakao(scope `,` 구분), x(PKCE 필수 — state 레코드가 verifier 운반)
- **10개 provider 전부 social login 연결** (기존: google/github만)

### 4.3 토큰

- access: JWT HS256(기존 secret 인프라 유지), claims `{ iss, aud, sub: userUUID, exp: 1h, iat, jti }`
- refresh: 불투명 랜덤 토큰, KV 저장 `{ userUUID, familyID, expiresAt }`, rotation + 재사용 감지
- 저장: localStorage (workers.dev ↔ pages.dev 크로스 도메인이라 httpOnly 쿠키 불가 — CSP로 보강, ADR-4)

## 5. 도메인 서비스

- **crawler-manager**: 기존 7 endpoint 계약 유지, 검증은 `packages/schemas` zod로 통일, 함정 14건 문서 반영 (코드 길이 제한 10K로 단일화 등)
- **scheduler-manager**: 기존 16 endpoint 계약 유지. run 라이프사이클 (pending→running→completed/partially_failed/failed), partial unique index 동시성 제어, `onlyIfStatus` guard, 5분 timeout+AbortSignal 전부 보존. **cron scheduled handler 신규 구현** — `SCHEDULED_EXECUTION_ENABLED` 환경변수로 게이트 (기본 false, 운영 배포 시 명시적 활성화)
- **code-runner**: Lambda function 단일화 (배포 비활성이던 CF worker 삭제). node:vm sandbox + SSRF 방어 + 5s timeout 보존. **Bearer JWT 검증 추가** (기존: 무인증 ⚠️)

## 6. 데이터 계층

- 기존 migration 8개: 파일명/내용 그대로 보존 (Supabase migration registry와 일치 필수)
- 신규 migration 2개 추가: ① social login user+account upsert RPC ② crawler+owner permission 생성 RPC — 비트랜잭션 2단계 쓰기 제거
- `database-connector`: 테이블별 repository 모듈 (`users.ts`, `crawlers.ts`, `schedulers.ts`, ...), 409 처리는 인덱스 이름 문자열 매칭 대신 Postgres error code 기반으로 개선
- RLS는 도입하지 않음 — 클라이언트가 Supabase에 직접 접근하지 않고 secret key는 worker 전용 (ADR-7). 격리는 repository 계층에서 `user_uuid` 필수 파라미터로 강제

## 7. Web 애플리케이션

- **스택**: React 19 + Vite 7 + React Router 7 + TanStack Query 5 + **Jotai** (세션/토스트 등 소수 전역 atom — 기존 Context 3개 대체, 죽은 의존성 zustand/recoil 제거)
- **스타일**: CSS Modules + design token (CSS 변수) — Emotion 런타임 제거. **light/dark 테마 + 반응형** (기존: 다크 단일, 반응형 미설계). frontend-design skill로 디자인 시스템 수립
- **구조**: `pages/`는 얇게, 도메인 UI는 `features/{crawlers,schedulers,authentication}/` 하위에 components/hooks 배치
- **보존 UX** (스펙 14항): 3모드 에디터(create/view/edit), dirty 3중 안전망, ⌘S/⌘E/⌘↵, draft 테스트 실행, optimistic reorder+rollback, run history 확장 행 등
- **개선 UX** (스펙 11항): 831줄 페이지 분해, 로딩/에러 상태 일관화, 접근성(키보드/ARIA), 빈 상태 디자인 등
- **테스트**: Vitest + Testing Library + MSW (기존 18개 파일의 시나리오 계승), 죽은 설정(Playwright 0개, Storybook 0개)은 재도입하지 않음 — 필요 시 후속

## 8. 품질 게이트

- **ESLint 9 flat config (root 단일)** — typescript-eslint strict-type-checked + `prefer-nullish-coalescing`(CLAUDE.md `??` 규약 기계화) + react-hooks (web)
- **Prettier** root 단일 설정
- **tsc --noEmit** per package (base tsconfig 상속, strict)
- **Vitest** 전 패키지 — 외부 네트워크 없는 테스트만
- **Turbo** 파이프라인: build/dev/lint/typecheck/test/format — CI도 turbo 경유로 통일 (기존: pnpm --filter 수동)
- **CI**: test 4개(web/packages/workers/functions) + deploy 6개 구조 유지, 새 패키지 구조 반영

## 9. 보안 이슈 → 해결 매핑

| # | 기존 이슈 (스펙 출처) | 해결 |
|---|----------------------|------|
| 1 | access_token이 redirect URL에 노출 | 일회용 authorization code 중계 (§4.1) |
| 2 | id_token 서명 미검증 | JWKS 서명 검증 (google/apple/microsoft) |
| 3 | nonce 생성만 하고 미검증 | callback에서 검증 |
| 4 | PKCE 생성만 하고 미사용 | 지원 provider 전부 적용, state 레코드가 verifier 운반 |
| 5 | code-runner 무인증 호출 | Bearer JWT 검증 |
| 6 | refresh 없는 장수명 토큰 | 1h access + rotating refresh + 재사용 감지 |
| 7 | token-exchange 모듈 중복 | authentication-worker로 단일화 |
| 8 | 6개 provider dead-end | 10개 전부 연결 |
| 9 | 클라이언트 zod(email 필수)가 canonical보다 엄격 | email nullable로 통일 |
| 10 | 비트랜잭션 2단계 쓰기 | RPC 트랜잭션화 (§6) |
| 11 | 인덱스 이름 문자열 의존 409 | Postgres error code 기반 |
| 12 | CORS/origin 일관성 | worker-foundation middleware로 단일화 |

## 10. 결정 로그 (ADR)

- **ADR-1 단일 OAuth worker**: 코드 중복 제거가 최우선. ⚠️ 운영 마이그레이션: 각 provider 개발자 콘솔의 redirect URI를 `.../providers/{provider}/callback`으로 재등록 필요 (README 마이그레이션 노트에 기재)
- **ADR-2 code-runner Lambda 단일화**: production 소비자가 Lambda function뿐 (CF worker 배포는 `if: false`). 보안 초집합(node:vm + SSRF 방어) 보유 측을 유지
- **ADR-3 무빌드 TS 패키지**: 모든 소비자가 TS 직접 소비 가능. 빌드 산출물/버전 불일치 제거
- **ADR-4 localStorage 토큰**: 크로스 도메인(workers.dev/pages.dev)이라 httpOnly 쿠키 불가. 짧은 access + rotation으로 노출 창 최소화
- **ADR-5 CSS Modules**: Emotion 런타임 비용/React 19 호환 리스크 제거, 토큰 기반 테마
- **ADR-6 cron feature flag**: 미구현이던 자동 실행을 완성하되 배포 직후 예기치 않은 실행 방지
- **ADR-7 RLS 미도입**: secret key가 RLS를 bypass하므로 실효 없음. repository 계층 강제가 실질 격리

## 11. 실행 순서

1. 기존 코드 wipe → root foundation (workspace/turbo/tsconfig/eslint/prettier)
2. packages: schemas → logger → database-connector → worker-foundation → authentication-core → authentication-providers
3. workers: authentication → crawler-manager → scheduler-manager
4. functions: crawler-code-runner
5. web
6. CI/CD + README + 마이그레이션 노트
7. 전체 검증 (turbo typecheck/test/build/lint)
