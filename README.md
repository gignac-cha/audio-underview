# audio-underview

사용자가 웹 UI에서 크롤러 코드를 작성하고, 스케줄러로 다단계 파이프라인을 구성·실행하는
플랫폼. pnpm workspace + Turbo monorepo.

> 이 저장소는 2026-07 완전 재작성본이다. 설계 배경과 결정은
> [`documents/architecture.md`](documents/architecture.md), 기존 시스템의 계약 스펙은
> [`documents/specifications/`](documents/specifications/)에 있다.

## 구성

```
applications/web                          React 19 + Vite SPA (Cloudflare Pages)
workers/authentication-worker             OAuth 10-provider 통합 + 토큰 발급/갱신 (Cloudflare Worker)
workers/crawler-manager-worker            crawler CRUD + 실행 RPC (Cloudflare Worker)
workers/scheduler-manager-worker          scheduler/stage/run + cron (Cloudflare Worker)
functions/crawler-code-runner-function    사용자 코드 샌드박스 실행 (AWS Lambda, node:vm)
packages/schemas                          전 API 계약의 zod 스키마 (web ↔ workers 단일 진실)
packages/logger                           구조화 로거 (console/Axiom transport)
packages/database-connector              Supabase repository + migrations
packages/worker-foundation               라우터/CORS/JWT/미들웨어
packages/authentication-core             OAuth 플로우 엔진 (state/PKCE/nonce, JWKS, 토큰)
packages/authentication-providers        provider strategy 10개
tools/environment-generator              1Password → .env 생성기
```

## 아키텍처 요약

- **인증**: 단일 authentication-worker가 10개 provider(`/providers/:provider/authorize`,
  `/callback`)를 서비스한다. callback은 토큰을 URL에 노출하지 않고 일회용 authorization
  code만 프론트로 전달하며, 프론트가 `POST /tokens`로 access(1h) + rotating refresh(30d)
  토큰 쌍으로 교환한다. ID 토큰은 JWKS로 서명 검증한다.
- **도메인**: crawler-manager가 crawler CRUD와 실행 RPC를, scheduler-manager가 파이프라인
  실행(fan-out/타임아웃/동시성 제어)과 cron 자동 실행을 담당한다.
- **코드 실행**: 사용자 크롤러 코드는 AWS Lambda의 `node:vm` 샌드박스에서 SSRF 방어 +
  5초 타임아웃으로 실행된다. Bearer JWT 인증이 필요하다.
- **데이터**: Supabase(Postgres). 서버(worker) 전용 secret key로 접근하며, 사용자 격리는
  repository 계층에서 `user_uuid` 조건으로 강제한다.

## 요구 사항

- Node.js >= 25.2.1 (TypeScript를 `node script.ts`로 직접 실행)
- pnpm 10.26.1

## 로컬 개발

```bash
pnpm install

# 1Password에서 로컬 .env 파일 생성 (op CLI 로그인 필요)
eval "$(op signin)"
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate

# 개발 서버
pnpm dev            # 전체 (turbo)
pnpm --filter @audio-underview/web dev   # web만
```

환경변수 템플릿: [`applications/web/.env.example`](applications/web/.env.example),
[`.env.workers.example`](.env.workers.example).

## 검증

```bash
pnpm typecheck   # 전 패키지 tsc --noEmit
pnpm test        # 전 패키지 vitest (외부 네트워크 없음)
pnpm lint        # root ESLint (strict-type-checked)
pnpm build       # 빌드 산출물
```

## 배포

GitHub Actions(`.github/workflows/`)로 수행한다.

- **web** → Cloudflare Pages (`deploy-web.yml`). PR은 `/deploy:preview` label로 preview 배포.
- **workers** → `deploy-authentication-worker.yml` / `deploy-crawler-worker.yml` /
  `deploy-scheduler-worker.yml` (`workflow_dispatch`). worker secret은 CI 밖에서 수동 관리
  (`wrangler secret put`, 소스: `.env.workers`).
- **code-runner** → AWS Lambda (`deploy-crawler-function.yml`).
- **DB migration** → Supabase Management API (`deploy-database-migrations.yml`,
  `packages/database-connector/migrations/**` push 시).

## ⚠️ 운영 마이그레이션 노트

OAuth provider가 개별 worker에서 단일 authentication-worker로 통합되었다(ADR-1). 배포 전
**각 provider 개발자 콘솔의 redirect URI를 새 경로로 재등록**해야 한다:

```
https://audio-underview-authentication-worker.<account>.workers.dev/providers/{provider}/callback
```

기존 Cloudflare 리소스 이름(worker/Pages/KV namespace `6a8c4022...`)과 Supabase migration
등록 이름은 그대로 계승되므로 데이터/바인딩 재생성은 불필요하다.
