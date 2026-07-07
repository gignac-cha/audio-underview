# environment-generator

1Password vault(`Audio Underview`)에서 secret을 읽어 로컬 `.env` 파일들을 생성하는 도구.
값은 repo에 커밋되지 않으며, 생성된 파일은 로컬 개발/수동 배포 작업에서만 사용한다.

## 생성 파일

| 파일 | 용도 |
|---|---|
| `applications/web/.env` | Vite 빌드타임 키 (`VITE_AUTHENTICATION_WORKER_URL`, `VITE_CRAWLER_MANAGER_WORKER_URL`, `VITE_SCHEDULER_MANAGER_WORKER_URL`, `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`) |
| `<root>/.env.workers` | authentication-worker secret 주입용 (`wrangler secret put` 소스) — provider 10개 credential + `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `FRONTEND_URL`, `ALLOWED_ORIGINS` |
| `<root>/.env.deploy` | 배포 자격증명 (GitHub secrets/vars 등록용 로컬 사본) — `CLOUDFLARE_*`, `AWS_*` |

`.env.workers` / `.env.deploy`는 다른 코드가 자동으로 읽지 않는다 — 수동으로 source하거나 CLI에 넘기는 용도.

## 사용법

```bash
# 1. 1Password CLI 로그인 (개인 vault에서 service account 토큰을 읽기 위함)
eval $(op signin)

# 2. 토큰 획득 + .env 생성 (repo 루트에서)
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate
```

- `setup`: `op read`로 service account 토큰을 stdout에 출력.
  참조 경로는 `OP_SERVICE_ACCOUNT_REFERENCE` 환경변수로 재정의 가능
  (기본값 `op://Personal/Service Account - Audio Underview/credential`).
- `generate`: `@1password/sdk`로 vault 참조를 일괄 resolve해 `.env` 파일 생성.
  빈 값/`REPLACE_ME`는 건너뛴다.

## 1Password 참조 경로

매핑은 `sources/environment-definitions.ts`에 있다. 재작성에서 새로 추가된 키
(authentication-worker URL, Supabase, JWT, LinkedIn/X provider 등)의 참조 경로는
합리적 추정값이므로 **실제 vault 항목명 확인 필요** — 주석에 표시해 두었다.

## 테스트

```bash
pnpm --filter @audio-underview/environment-generator test        # 순수 함수 단위 테스트 (1Password 호출 없음)
pnpm --filter @audio-underview/environment-generator typecheck
```
