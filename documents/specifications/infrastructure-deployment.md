# Infrastructure / Deployment / Development Environment Specification

조사 기준: 2026-07-06, branch `main` (worktree `refactor-rewrite-20260706`).
목적: 재작성(rewrite) 후에도 동일한 배포 파이프라인이 동작하도록 현재 인프라 구성을 전수 기록.

---

## 1. Cloudflare Workers — wrangler.toml 전수 명세

wrangler.toml 파일은 총 13개: `applications/web/wrangler.toml` + `workers/*/wrangler.toml` 12개.
모든 worker 공통값 (예외는 테이블에 명시):

- `main = "sources/index.ts"`
- `compatibility_date = "2025-11-25"`
- `[vars] ALLOWED_ORIGINS = "http://localhost:5173,https://audio-underview.pages.dev"`
- `[observability.logs] enabled = true`, `head_sampling_rate = 1`, `invocation_logs = true`
- routes / custom domain 설정 **없음** (전부 기본 `*.workers.dev` 도메인)
- OAuth worker 8개는 동일한 KV namespace 공유: binding `AUDIO_UNDERVIEW_OAUTH_STATE`, id `6a8c4022e9984b0fb81957ed410ad9b0`

| Worker 디렉토리 | name | compat flags | KV | 기타 binding | 추가 [vars] | Secrets (wrangler secret put) |
|---|---|---|---|---|---|---|
| `workers/google-oauth-provider-worker` | `audio-underview-google-oauth-provider-worker` | `nodejs_compat` | OAUTH_STATE | — | `AXIOM_DATASET=audio-underview` | GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FRONTEND_URL, SUPABASE_URL, SUPABASE_SECRET_KEY, AXIOM_API_TOKEN |
| `workers/github-oauth-provider-worker` | `audio-underview-github-oauth-provider-worker` | `nodejs_compat` | OAUTH_STATE | — | `AXIOM_DATASET=audio-underview` | GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, FRONTEND_URL, SUPABASE_URL, SUPABASE_SECRET_KEY, AXIOM_API_TOKEN |
| `workers/apple-oauth-provider-worker` | `audio-underview-apple-oauth-provider-worker` | — | OAUTH_STATE | — | — | APPLE_CLIENT_ID (Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (PEM), FRONTEND_URL |
| `workers/microsoft-oauth-provider-worker` | `audio-underview-microsoft-oauth-provider-worker` | — | OAUTH_STATE | — | `MICROSOFT_TENANT=common` | MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, FRONTEND_URL |
| `workers/facebook-oauth-provider-worker` | `audio-underview-facebook-oauth-provider-worker` | — | OAUTH_STATE | — | — | FACEBOOK_CLIENT_ID, FACEBOOK_CLIENT_SECRET, FRONTEND_URL |
| `workers/discord-oauth-provider-worker` | `audio-underview-discord-oauth-provider-worker` | — | OAUTH_STATE | — | — | DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, FRONTEND_URL |
| `workers/kakao-oauth-provider-worker` | `audio-underview-kakao-oauth-provider-worker` | — | OAUTH_STATE | — | — | KAKAO_CLIENT_ID (REST API Key), KAKAO_CLIENT_SECRET (optional), FRONTEND_URL |
| `workers/naver-oauth-provider-worker` | `audio-underview-naver-oauth-provider-worker` | — | OAUTH_STATE | — | — | NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, FRONTEND_URL |
| `workers/crawler-manager-worker` | `audio-underview-crawler-manager-worker` | — | — | — | — | SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET, CODE_RUNNER_FUNCTION_URL |
| `workers/scheduler-manager-worker` | `audio-underview-scheduler-manager-worker` | — | — | `[[services]] binding=CRAWLER_MANAGER → service=audio-underview-crawler-manager-worker` | — | SUPABASE_URL, SUPABASE_SECRET_KEY, JWT_SECRET |
| `workers/crawler-code-runner-worker` | `audio-underview-crawler-code-runner-worker` | — | — | `[[worker_loaders]] binding=LOADER` | — | — |
| `workers/tools` | `worker-tools-test` | — | OAUTH_STATE (id=`test-kv-id`) | — | `FRONTEND_URL=https://example.com`, `ALLOWED_ORIGINS=https://example.com,https://app.example.com` | — |

주의 사항:

- `workers/tools` (`@audio-underview/worker-tools`)는 **배포 대상이 아님**. wrangler.toml은 `@cloudflare/vitest-pool-workers` 테스트 전용 (KV id도 `test-kv-id` placeholder). deploy script 없음.
- `crawler-code-runner-worker`는 Cloudflare **WorkerLoader API 미지원으로 배포 비활성** (workflow에서 `if: false`). 실제 운영은 AWS Lambda 대체본(`functions/crawler-code-runner-function`) 사용.
- Secret 목록은 wrangler.toml 내 주석으로만 문서화되어 있음 (실제 값은 `wrangler secret put` 또는 wrangler-action `secrets:` 입력으로 주입).

### 1.1 Web (applications/web/wrangler.toml)

```toml
name = "audio-underview"
compatibility_date = "2025-12-17"
[assets]
directory = "./outputs"
not_found_handling = "single-page-application"
```

- Workers Static Assets 형식의 config지만, **CI 배포는 Cloudflare Pages** (`wrangler pages deploy`, project `audio-underview`)로 수행됨 — 이 wrangler.toml은 CI 배포 경로에서 사용되지 않음 (repo 루트에서 `pages deploy` 명령 실행). 로컬 preview 또는 Workers Assets 이행 대비용으로 보임.
- Production URL: `https://audio-underview.pages.dev` (workers의 ALLOWED_ORIGINS에 하드코딩됨).

---

## 2. GitHub Actions Workflows (11개, `.github/workflows/`)

### 공통 step 패턴 (배포/테스트 job 대부분 동일)

1. `actions/checkout@v4`
2. `pnpm/action-setup@v4` (버전은 root package.json `packageManager: pnpm@10.26.1`에서 추론)
3. `actions/setup-node@v4` — `node-version: '25'`, `cache: 'pnpm'` (**예외**: `deploy-crawler-workers.yml`만 `node-version: 'latest'`)
4. `pnpm install --frozen-lockfile`
5. Cloudflare 배포는 전부 `cloudflare/wrangler-action@v3`, `apiToken: secrets.CLOUDFLARE_API_TOKEN`, `accountId: vars.CLOUDFLARE_ACCOUNT_ID`

### 2.1 Deploy workflows

| Workflow | Trigger | 배포 대상 | 비고 |
|---|---|---|---|
| `deploy-oauth-workers.yml` | `workflow_dispatch` (provider별 boolean input 8개: google/apple/microsoft/facebook/github/discord/kakao/naver + `deploy_all`) | OAuth worker 8개, provider당 독립 job | wrangler-action `command: deploy` + `secrets:` 입력으로 worker secret 동시 주입 |
| `deploy-crawler-workers.yml` | `workflow_dispatch` (input: crawler_code_runner / crawler_manager / deploy_all) | crawler-manager-worker (code-runner job은 `if: false`로 비활성) | node `latest` 사용 |
| `deploy-scheduler-worker.yml` | `workflow_dispatch` (input 없음) | scheduler-manager-worker | secret 주입 없음 (worker secret은 수동 관리) |
| `deploy-crawler-functions.yml` | `workflow_dispatch` (input: crawler_code_runner / deploy_all) | AWS Lambda `audio-underview-crawler-code-runner-function` | 아래 2.2 참조 |
| `deploy-database-migrations.yml` | `workflow_dispatch` + `push` main, paths `packages/supabase-connector/migrations/**` | Supabase DB | 아래 2.3 참조. concurrency group `deploy-database-migrations`, `cancel-in-progress: false` |
| `deploy-web.yml` | `workflow_dispatch` + `push` main (paths `applications/web/**`, `packages/**`) + `pull_request` main (`types: [labeled, synchronize]`, 동일 paths) | Cloudflare Pages project `audio-underview` | 아래 2.4 참조 |
| `deactivate-preview.yml` | `pull_request` main `types: [closed]` | GitHub deployment environment `preview` 비활성화 | `strumwolf/delete-deployment-environment@v3`, `onlyDeactivateDeployments: true`, `secrets.GITHUB_TOKEN` |

### 2.2 deploy-crawler-functions.yml (AWS Lambda) 상세

- Build: `functions/crawler-code-runner-function`에서 `node build.ts` (esbuild: entry `sources/index.ts` → `outputs/index.mjs`, bundle, minify, sourcemap, platform node, target node22, format esm)
- Package: `outputs/`에서 `zip function.zip index.mjs`
- `aws-actions/configure-aws-credentials@v4` — `secrets.AWS_ACCESS_KEY_ID`, `secrets.AWS_SECRET_ACCESS_KEY`, `vars.AWS_REGION`
- Lambda 스펙 (create/update 공통): function name `audio-underview-crawler-code-runner-function`, runtime `nodejs24.x`, handler `index.handler`, timeout `30`, memory `256`, env `{"ALLOWED_ORIGINS": vars.ALLOWED_ORIGINS}`
- Create 시에만: `--role secrets.AWS_LAMBDA_EXECUTION_ROLE_ARN`
- 존재 여부 체크(`aws lambda get-function`) 후 create-function 또는 update-function-code → `wait function-updated-v2` → update-function-configuration 분기

### 2.3 deploy-database-migrations.yml 상세

- Supabase Management API 직접 호출: `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/database/migrations`
- Auth: `Bearer secrets.SUPABASE_ACCESS_TOKEN`, project ref: `vars.SUPABASE_PROJECT_ID`
- 로직: 적용된 migration 이름 목록 GET → `packages/supabase-connector/migrations/*.sql` 순회 → 파일명에서 `NNN_` prefix 제거한 name으로 중복 체크 → 미적용분만 `{name, query}` JSON으로 POST (idempotent)
- Migration 파일 명명: `001_create_users_and_accounts.sql` ~ `008_add_fan_out_strategy.sql` (숫자 prefix + underscore)

### 2.4 deploy-web.yml 상세

- Concurrency: `deploy-web-${{ PR number || ref }}`, `cancel-in-progress: true`
- PR 이벤트 시 label `/deploy:preview`가 있어야 실행 (`contains(labels.*.name, '/deploy:preview')` — quality/deploy 두 job 모두)
- Job `quality`: typecheck + lint (`pnpm --filter @audio-underview/web typecheck` / `lint`)
- Job `deploy` (needs: quality):
  - GitHub environment: PR이면 `preview`, 아니면 `production`; environment URL = wrangler-action의 `deployment-url` output
  - Build: `pnpm --filter @audio-underview/web build`, build env:
    - `VITE_GOOGLE_CLIENT_ID` ← **secrets**
    - `VITE_GOOGLE_OAUTH_WORKER_URL`, `VITE_GITHUB_OAUTH_WORKER_URL`, `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`, `VITE_CRAWLER_MANAGER_WORKER_URL` ← **vars**
  - Deploy: `wrangler-action@v3` `command: pages deploy ./applications/web/outputs --project-name=audio-underview --branch=${{ github.head_ref || github.ref_name }}` + `gitHubToken: secrets.GITHUB_TOKEN`
  - Post: `actions/github-script@v7`로 commit status (`context: 'Cloudflare Pages'`) 생성 + step summary 테이블
  - Permissions: `contents: read`, `deployments: write`, `statuses: write`

### 2.5 Test workflows (4개)

전부 `pull_request` → main, path filter, concurrency `test-*-${{ PR number }}` cancel-in-progress, permissions `contents: read` + `checks: write`, 결과는 `mikepenz/action-junit-report@v5`로 report. vitest는 `--reporter=default --reporter=junit --outputFile.junit=test-results.xml`.

| Workflow | Path filter | Steps 요약 |
|---|---|---|
| `test-web.yml` | `applications/web/**`, `packages/**`, self | typecheck → lint → `playwright install --with-deps chromium` → vitest (web은 browser-mode 테스트) |
| `test-workers.yml` | `workers/**`, `packages/**` | `pnpm -r --filter './workers/*' run typecheck` → `pnpm --filter './workers/*' exec vitest run ...` |
| `test-packages.yml` | `packages/**`, self | `pnpm -r --filter './packages/*' run typecheck` → `run test` |
| `test-functions.yml` | `functions/**`, `packages/**`, self | `pnpm -r --filter './functions/*' run typecheck` → crawler-code-runner-function만 vitest |

### 2.6 GitHub Secrets / Variables 전체 인벤토리

**Repository secrets:**

| Secret | 사용 workflow |
|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy-oauth-workers, deploy-crawler-workers, deploy-scheduler-worker, deploy-web |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_LAMBDA_EXECUTION_ROLE_ARN` | deploy-crawler-functions |
| `SUPABASE_ACCESS_TOKEN` | deploy-database-migrations |
| `VITE_GOOGLE_CLIENT_ID` | deploy-web (build) |
| `GOOGLE_CLIENT_SECRET` | deploy-oauth-workers (google) |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | deploy-oauth-workers (apple) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | deploy-oauth-workers (microsoft) |
| `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | deploy-oauth-workers (facebook) |
| `OAUTH_GITHUB_CLIENT_SECRET` | deploy-oauth-workers (github) — `GITHUB_` prefix가 GitHub Actions 예약어라 `OAUTH_` prefix 사용 |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | deploy-oauth-workers (discord) |
| `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET` | deploy-oauth-workers (kakao) |
| `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | deploy-oauth-workers (naver) |
| `FRONTEND_URL` | deploy-oauth-workers (apple/microsoft/facebook/discord/kakao/naver — **google/github는 vars 사용**) |
| `GITHUB_TOKEN` (자동 제공) | deploy-web, deactivate-preview |

**Repository variables (vars):**

| Variable | 사용 workflow |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 모든 Cloudflare 배포 |
| `AWS_REGION`, `ALLOWED_ORIGINS` | deploy-crawler-functions |
| `SUPABASE_PROJECT_ID` | deploy-database-migrations |
| `GOOGLE_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_ID`, `FRONTEND_URL` | deploy-oauth-workers (google/github job) |
| `VITE_GOOGLE_OAUTH_WORKER_URL`, `VITE_GITHUB_OAUTH_WORKER_URL`, `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`, `VITE_CRAWLER_MANAGER_WORKER_URL` | deploy-web (build) |

**GitHub environments:** `production`, `preview` (deploy-web에서 선택, deactivate-preview가 PR close 시 preview deployment 비활성화).

**비일관성 (재작성 시 정리 후보):** google/github job은 client ID·FRONTEND_URL을 vars에서, 나머지 6개 provider는 secrets에서 읽음. 동작은 동일하나 secret/var 등록 위치가 provider마다 다르므로 마이그레이션 시 양쪽 다 확인 필요.

---

## 3. environment-generator (`tools/environment-generator/`)

1Password 기반 로컬 `.env` 파일 생성기. root package.json script로 노출:
`environment:setup` → `pnpm --filter @audio-underview/environment-generator run setup`, `environment:generate` → `... run generate`.

### 3.1 setup.ts (`sources/setup.ts`)

- 1Password **CLI** (`op read`)로 Service Account 토큰을 읽어 stdout에 출력 (10초 timeout)
- 참조 경로: env `OP_SERVICE_ACCOUNT_REFERENCE` ?? 기본값 `op://Personal/Service Account - Audio Underview/credential` (개인 vault에 저장된 service account credential)
- 에러 분기: op 미설치(ENOENT) / 미로그인 / 기타 → stderr 메시지 + exit 1

### 3.2 generate.ts (`sources/generate.ts`)

- 입력: env `OP_SERVICE_ACCOUNT_TOKEN` (setup.ts 출력을 파이프)
- `@1password/sdk` `createClient` (integrationName `audio-underview`) → `secrets.resolveAll()`로 vault `Audio Underview`의 14개 참조를 일괄 resolve
- 값이 빈 문자열이거나 `REPLACE_ME`면 skip (warn)
- 출력 형식: `KEY="value"` 줄 단위, 3개 파일 생성:

| 출력 파일 | Keys | 1Password 참조 (op://Audio Underview/...) |
|---|---|---|
| `applications/web/.env` | VITE_GOOGLE_CLIENT_ID, VITE_GITHUB_OAUTH_WORKER_URL, VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL, VITE_CRAWLER_MANAGER_WORKER_URL | `Google OAuth/client ID`, `GitHub OAuth Worker/URL`, `Crawler Code Runner Function/URL`, `Crawler Manager Worker/URL` |
| `<root>/.env.workers` | OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET, FRONTEND_URL, ALLOWED_ORIGINS | `GitHub OAuth/client ID`, `GitHub OAuth/client secret`, `Frontend/URL`, `Frontend/allowed origins` |
| `<root>/.env.deploy` | CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_LAMBDA_EXECUTION_ROLE_ARN, AWS_REGION | `Cloudflare/API token`, `Cloudflare/account ID`, `AWS/access key ID`, `AWS/secret access key`, `AWS/Lambda execution role ARN`, `AWS/region` |

사용법 (README):

```bash
eval $(op signin)
OP_SERVICE_ACCOUNT_TOKEN=$(pnpm run --silent environment:setup) pnpm run environment:generate
```

- `.env.workers`/`.env.deploy`는 repo 내 다른 코드가 자동으로 읽지 않음 — 로컬에서 수동으로 source하거나 CLI에 넘기는 용도 (예: `.env.deploy` 값을 GitHub secrets/vars로 등록, `.env.workers` 값을 `wrangler secret put`에 사용).
- 의존성: `@1password/sdk ^0.4.0` 단일.

---

## 4. 개발 도구 체인

### 4.1 Runtime / Package Manager

- Node.js `>=25.2.1` (engines), TypeScript 파일은 `node script.ts`로 직접 실행 (CI도 `node build.ts` 직접 실행)
- `pnpm@10.26.1` (packageManager 필드 — CI의 pnpm/action-setup이 이 값 사용)
- Workspace globs (`pnpm-workspace.yaml`): `packages/*`, `applications/*`, `workers/*`, `functions/*`, `tools/*`
- pnpm **catalog** `worker`: `@cloudflare/vitest-pool-workers 0.12.10`, `@cloudflare/workers-types 4.20260207.0`, `@vitest/runner 3.2.4`, `@vitest/snapshot 3.2.4`, `vitest 3.2.4` — worker 패키지들은 `catalog:worker`로 참조. **주의: web/functions는 vitest ^4.0.18 사용 (worker와 major 버전 다름, vitest-pool-workers 호환성 때문)**

### 4.2 Root devDependencies

`@types/node ^25.0.3`, `esbuild ^0.27.2` (functions build), `eslint ^9.39.2`, `prettier ^3.7.4`, `turbo ^2.7.0`, `typescript ^5.9.3`, `wrangler ^4.56.0` (모든 worker의 dev/deploy가 root의 wrangler 사용 — worker 개별 devDep에 wrangler 없음)

### 4.3 turbo.json tasks

| Task | dependsOn | outputs | cache |
|---|---|---|---|
| `build` | `^build` | `outputs/**` | ✓ |
| `dev` | — | — | ✗, persistent |
| `lint` | `^build` | — | ✓ |
| `typecheck` | `^build` | — | ✓ |
| `test` | `^build` | — | ✓ |
| `format` | — | — | ✗ |

Root scripts: `build`/`dev`/`lint`/`typecheck`/`test` = `turbo run <task>`, `format`/`format:check` = prettier 직접 실행 (turbo 경유 아님). **단, CI는 turbo를 쓰지 않고 `pnpm --filter`로 직접 실행함.**

### 4.4 tsconfig 상속 구조

- **Root `tsconfig.json`**: `target ESNext`, `module NodeNext`, `moduleResolution NodeNext`, `strict`, `noEmit`, `declaration(+Map)`, `sourceMap`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`, `resolveJsonModule`, `lib [ESNext]`, `types [node]` — Node 네이티브 TS 실행(erasable syntax) 전제 구성
- **workers/* tsconfig**: `extends ../../tsconfig.json` + override `types: ["@cloudflare/workers-types"]`, `lib: ["ESNext", "DOM"]`
- **functions/* tsconfig**: `extends ../../tsconfig.json` + `types: ["node"]`, `lib: ["ESNext"]`
- **packages/* tsconfig**: root를 **extends 하지 않음** (standalone) — `module ESNext`/`moduleResolution bundler`, strict, noEmit, declaration(+Map), allowImportingTsExtensions
- **applications/web/tsconfig.json**: standalone — `target ES2022`, `lib [ES2022, DOM, DOM.Iterable]`, `moduleResolution bundler`, `jsx react-jsx`, path alias `@/* → sources/*` (vite.config.ts의 alias와 동일), include `sources` + `vite.config.ts`, test 파일 exclude

### 4.5 Lint / Format 실태

- **ESLint 9 (flat config)는 web에만 존재**: `applications/web/eslint.config.js` 단 1개 (`find` 전수 확인, `.eslintrc*` 없음). 구성: `@eslint/js` recommended + `typescript-eslint` recommended + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`, `ignores: ['outputs']`, `@typescript-eslint/no-unused-vars`는 `_` prefix 허용. root devDeps의 `eslint ^9.39.2`는 hoist용이며 root 자체 config는 없음.
- **`lint` script도 web에만 존재** (`eslint sources`). `turbo run lint`는 사실상 web만 실행. packages/workers/functions는 lint 없이 typecheck만.
- **Prettier**: `.prettierrc` = `{ "printWidth": 160, "singleQuote": true }`. `.prettierignore` 없음. CI에서 format check 실행 안 함 (로컬 전용).

### 4.6 Web 빌드/테스트 스택

- Vite 7 + `@vitejs/plugin-react` (babel-plugin-react-compiler 활성) + `@vitejs/plugin-basic-ssl` (로컬 dev는 https), `build.outDir: 'outputs'`
- build script: `tsc -b && vite build`
- 테스트: vitest 4 browser mode (`@vitest/browser-playwright`, `vitest-browser-react`, msw) — CI에서 Chromium 설치 필요
- 부가: Storybook 10, Playwright e2e (`e2e` script — CI 미연동)
- Worker 테스트: `@cloudflare/vitest-pool-workers`, `vitest.config.ts`에서 `wrangler: { configPath: './wrangler.toml' }` + miniflare `bindings`로 secret 테스트값 주입

---

## 5. 환경변수 전체 맵

### 5.1 컴포넌트별 소비 키

| 컴포넌트 | Key | 주입 경로 |
|---|---|---|
| **web (빌드타임, `import.meta.env`)** | `VITE_GOOGLE_CLIENT_ID` | CI: secrets / 로컬: `applications/web/.env` (generator 생성) |
| | `VITE_GOOGLE_OAUTH_WORKER_URL` | CI: vars / 로컬: **generator가 생성 안 함** (수동) |
| | `VITE_GITHUB_OAUTH_WORKER_URL` | CI: vars / 로컬: generator |
| | `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL` | CI: vars / 로컬: generator |
| | `VITE_CRAWLER_MANAGER_WORKER_URL` | CI: vars / 로컬: generator |
| | `VITE_SCHEDULER_MANAGER_WORKER_URL` | **CI 빌드 env에 없음**, generator에도 없음. `.env.example`에는 존재 — 수동 주입 필요한 gap |
| **OAuth workers (런타임 env)** | `<PROVIDER>_CLIENT_ID`, `<PROVIDER>_CLIENT_SECRET`, `FRONTEND_URL` | wrangler secret (CI: wrangler-action `secrets:`) |
| | apple 추가: `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | wrangler secret |
| | google/github 추가: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AXIOM_API_TOKEN` | wrangler secret (**CI가 주입 안 함 — 수동 `wrangler secret put`**) |
| | `ALLOWED_ORIGINS`, (google/github) `AXIOM_DATASET`, (microsoft) `MICROSOFT_TENANT` | wrangler.toml `[vars]` |
| **crawler-manager-worker** | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`, `CODE_RUNNER_FUNCTION_URL` | wrangler secret (수동) |
| **scheduler-manager-worker** | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET` | wrangler secret (수동) + service binding `CRAWLER_MANAGER` |
| **Lambda (crawler-code-runner-function)** | `ALLOWED_ORIGINS` | Lambda environment (CI가 `vars.ALLOWED_ORIGINS`로 설정) |
| **CI 배포 자격증명** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AWS_*` 4종, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID` | GitHub secrets/vars (로컬 대응본: `.env.deploy`) |

### 5.2 .env 파일 인벤토리 (key만)

| 파일 | Keys | 생성 주체 |
|---|---|---|
| `applications/web/.env.example` | `VITE_GOOGLE_CLIENT_ID`, `VITE_SCHEDULER_MANAGER_WORKER_URL` | 수동 (repo 커밋됨) |
| `applications/web/.env` | `VITE_GOOGLE_CLIENT_ID`, `VITE_GITHUB_OAUTH_WORKER_URL`, `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`, `VITE_CRAWLER_MANAGER_WORKER_URL` | environment-generator |
| `<root>/.env.workers` | `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `FRONTEND_URL`, `ALLOWED_ORIGINS` | environment-generator (worker 로컬 개발/secret 등록용, 자동 로딩 없음) |
| `<root>/.env.deploy` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_LAMBDA_EXECUTION_ROLE_ARN`, `AWS_REGION` | environment-generator (배포 자격증명 — GitHub secrets/vars의 로컬 사본) |

### 5.3 알려진 gap / 비일관성 (재작성 시 확인)

1. `VITE_SCHEDULER_MANAGER_WORKER_URL` — 코드에서 사용하고 `.env.example`에 있으나 deploy-web.yml 빌드 env와 generator 양쪽 모두에 없음.
2. `.env.example`은 `VITE_GITHUB_OAUTH_WORKER_URL` 등 generator가 만드는 key 3개를 누락 (example이 실제보다 뒤처짐).
3. OAuth provider별 GitHub secrets/vars 위치 불일치 (2.6 참조).
4. google/github worker의 `SUPABASE_URL`/`SUPABASE_SECRET_KEY`/`AXIOM_API_TOKEN`과 crawler/scheduler worker의 모든 secret은 CI 파이프라인 밖에서 수동 주입 — 재작성 시 이 수동 단계가 유지되어야 함.
5. worker들의 `ALLOWED_ORIGINS`에 `http://localhost:5173` (http) 하드코딩 — 로컬 web dev server는 basicSSL로 https.

---

## 6. 재작성 시 보존해야 할 배포 계약 (요약 체크리스트)

- [ ] Cloudflare 리소스 이름 유지: worker 이름 12개 (`audio-underview-*`), Pages project `audio-underview`, KV namespace id `6a8c4022e9984b0fb81957ed410ad9b0` (binding `AUDIO_UNDERVIEW_OAUTH_STATE`), service binding `CRAWLER_MANAGER`
- [ ] AWS Lambda 이름 `audio-underview-crawler-code-runner-function` + handler/runtime/timeout/memory 스펙
- [ ] GitHub secrets/vars 이름 전체 (2.6 테이블) — workflow가 참조하는 이름 그대로
- [ ] deploy-web의 PR label 게이트 `/deploy:preview` + preview/production environment 구분
- [ ] Supabase migration 파일 명명 규칙(`NNN_name.sql`)과 Management API 기반 적용 방식 (이미 적용된 name 재적용 금지)
- [ ] Vite 빌드 output 경로 `outputs/` (wrangler pages deploy가 참조)
- [ ] pnpm workspace 필터 이름 (`@audio-underview/web` 등) — workflow의 `--filter` 인자가 패키지명에 의존
