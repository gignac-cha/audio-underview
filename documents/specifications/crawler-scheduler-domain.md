# Crawler / Scheduler Domain — 완전 스펙

> 재작성 시 보존해야 하는 API 계약과 실행 시맨틱의 소스 오브 트루스.
> 조사 기준: `main` @ 361283b (2026-07-06). 조사 범위:
> `workers/crawler-manager-worker`, `workers/scheduler-manager-worker`,
> `workers/crawler-code-runner-worker`, `functions/crawler-code-runner-function`,
> `packages/supabase-connector`(도메인 테이블/마이그레이션), `packages/logger`,
> `packages/axiom-logger`, `workers/tools`(worker-tools), `functions/tools`(function-tools).

**주의: 이 도메인에는 zod가 없다.** 요청 검증은 전부 수작업 타입 체크(hand-rolled)이며,
zod는 OAuth provider 패키지들과 web frontend(`applications/web/sources/schemas/`)에서만 사용된다.
아래 "스키마"는 소스의 검증 로직을 그대로 옮긴 것이다.

---

## 1. 도메인 개념

### 1.1 Crawler

사용자가 정의한 JavaScript 함수 한 개 + 메타데이터. 두 종류:

- **`web` crawler**: URL을 fetch한 응답 본문(text)을 함수의 인자로 받는다.
  `url_pattern`(regex, 문자열)이 필수. 생성/수정 시 `input_schema`는 서버가
  `{ body: 'string' }`으로 강제 덮어쓴다.
- **`data` crawler**: 임의의 JSON 데이터를 함수 인자로 받는다. `input_schema`(JSON object) 필수,
  `url_pattern`은 DB에 `null`로 저장.

```typescript
// CrawlerRow (packages/supabase-connector/sources/types/database.ts)
interface CrawlerRow {
  id: string;                              // UUID
  user_uuid: string;
  name: string;
  type: 'web' | 'data';                    // CrawlerType
  url_pattern: string | null;
  code: string;                            // JS 함수 소스: "(input) => ..." 형태
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  created_at: string;
  updated_at: string;                      // DB trigger로 자동 갱신
}
```

**Crawler permission**: crawler 생성 시 `crawler_permissions`에 `level: 'owner'` 행이 함께 생성된다.
scheduler stage에 crawler를 연결하려면 요청자의 permission 행이 존재해야 한다(`owner` | `subscriber`).

```typescript
type CrawlerPermissionLevel = 'owner' | 'subscriber';
interface CrawlerPermissionRow {
  id: string; crawler_id: string; user_uuid: string;
  level: CrawlerPermissionLevel; created_at: string;
}
```

### 1.2 Scheduler

crawler들을 순차 stage로 묶은 파이프라인 정의.

```typescript
interface SchedulerRow {
  id: string;
  user_uuid: string;
  name: string;
  cron_expression: string | null;   // 저장/검증만 됨 — 자동 실행 미구현 (아래 3.6 참조)
  is_enabled: boolean;              // DB default true
  last_run_at: string | null;       // 실행 종료 시(성공/실패 무관) 항상 갱신
  created_at: string;
  updated_at: string;
}
```

### 1.3 Stage

scheduler 내 실행 단위. crawler 하나를 참조하고, 실행 순서(`stage_order`, 0-based)와
fan-out 설정을 가진다.

```typescript
type FanOutStrategy = 'compact' | 'preserve';
interface SchedulerStageRow {
  id: string;
  scheduler_id: string;             // FK → schedulers, ON DELETE CASCADE
  crawler_id: string;               // FK → crawlers, ON DELETE RESTRICT (사용 중 crawler 삭제 방지)
  stage_order: number;              // INTEGER CHECK >= 0, UNIQUE(scheduler_id, stage_order) DEFERRABLE
  input_schema: Record<string, unknown>;   // { key: { default: value } } descriptor 형식
  output_schema: Record<string, unknown>;  // DB default '{}'
  fan_out_field: string | null;
  fan_out_strategy: FanOutStrategy;        // DB default 'compact' (migration 008)
  created_at: string;
}
```

### 1.4 Run / Stage Run

```typescript
type SchedulerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partially_failed';

interface SchedulerRunRow {          // 파이프라인 1회 실행 (update-in-place)
  id: string; scheduler_id: string;
  status: SchedulerRunStatus;        // DB default 'pending'
  started_at: string | null; completed_at: string | null;
  result: unknown;                   // 마지막 stage output (JSONB)
  error: string | null;
  created_at: string;
}

interface SchedulerStageRunRow {     // stage별 실행 기록 (디버깅/UI용)
  id: string; run_id: string; stage_id: string; stage_order: number;
  status: SchedulerRunStatus;
  started_at: string | null; completed_at: string | null;
  input: unknown; output: unknown; error: string | null;
  items_total: number | null;        // fan-out 전용 카운터 3종
  items_succeeded: number | null;
  items_failed: number | null;
  created_at: string;
}
```

**Run 상태 전이** (scheduler-executor.ts):

```
pending ──(executor 시작)──> running ──┬─> completed          (모든 stage 성공)
                                       ├─> partially_failed   (fan-out 일부 실패 있음, 파이프라인은 끝까지 감)
                                       └─> failed             (stage throw / fan-out 전부 실패 / 5분 timeout)
```

- 동시 실행 방지: DB partial unique index `scheduler_runs_one_active_per_scheduler`
  — `scheduler_id` 당 `status IN ('pending','running')` 인 run은 1개만 존재 가능 (migration 006).
- CHECK 제약: `completed_at >= started_at`, `items_succeeded + items_failed <= items_total`.

### 1.5 서비스 토폴로지

```
web frontend ──JWT──> crawler-manager-worker (CF Worker, WorkerEntrypoint)
             ──JWT──> scheduler-manager-worker (CF Worker)
             ──(인증 없음)──> crawler-code-runner-function (/run, mode:'test' — 에디터 테스트용)

scheduler-manager ──Service Binding RPC (CRAWLER_MANAGER.executeCrawler)──> crawler-manager
crawler-manager   ──HTTP POST {CODE_RUNNER_FUNCTION_URL}/run (mode:'run')──> crawler-code-runner-function (AWS Lambda)

crawler-code-runner-worker (CF Worker + Worker Loader): 동일 HTTP 계약의 CF 구현.
현재 production 소비자 없음 (frontend와 crawler-manager 모두 *_FUNCTION_URL 사용).
```

---

## 2. 공통 규약 (모든 worker/function)

### 2.1 에러 응답 형식

```json
{ "error": "<error_code>", "error_description": "<사람이 읽는 설명>" }
```

- worker-tools `errorResponse(error, errorDescription, status, context)` /
  function-tools 동일 시그니처(반환형만 `LambdaResponse`).
- 에러 코드 어휘: `invalid_request`, `unauthorized`, `forbidden`, `not_found`,
  `method_not_allowed`, `conflict`, `server_error`, `execution_failed`, `execution_timeout`,
  `fetch_failed`, `fetch_timeout`, `response_too_large`, `network_error`(client 내부),
  `invalid_response`(client 내부), `invalid_state`(OAuth용).

### 2.2 CORS

- `createCORSHeaders(origin, allowedOrigins, logger)`: `ALLOWED_ORIGINS`는 콤마 구분 문자열.
  origin이 목록에 있으면 `Access-Control-Allow-Origin: <origin>` + `Allow-Credentials: true` + `Vary: Origin`.
  `*` 포함 시 `Allow-Origin: *` (credentials 없음). origin 미허용/빈 값이면 CORS 헤더 자체를 생략.
  기본 `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Content-Type`.
- manager worker들은 OPTIONS 처리 시 `Allow-Methods: GET, POST, PUT, DELETE, OPTIONS`,
  `Allow-Headers: Content-Type, Authorization`으로 덮어쓴다. → **204** (body 없음).
- `HEAD` → **200**, `Content-Type: application/json`, body 없음 (모든 서비스 공통).

### 2.3 인증 (JWT)

- 자체 HS256 JWT (worker-tools/jwt.ts, WebCrypto HMAC-SHA256, base64url).
- Payload: `{ sub: string(user UUID), iat: number, exp: number, [key: string]: unknown }`.
- `verifyJWT` 실패 조건 → `null`: 3-part 아님 / 서명 불일치 / `sub` 없음·비문자열 /
  `iat`·`exp` 비숫자 / `exp < now`.
- 보호 라우트: `Authorization: Bearer <token>` 필수, 실패 시
  **401** `unauthorized` / "Valid authentication is required".
- **차이점**: scheduler-manager는 JWT `sub`가 UUID 형식이 아니면 추가로 401 처리.
  crawler-manager는 이 검사 없음.

### 2.4 토큰 교환 — `POST /authentication/token` (양쪽 manager worker에 동일 구현 복제)

Request (인증 불필요):
```typescript
{ provider: 'google' | 'github', access_token: string }
```
동작: provider API로 사용자 확인 (Google: `GET googleapis.com/oauth2/v3/userinfo`의 `sub`;
GitHub: `GET api.github.com/user`의 숫자 `id`, 5초 timeout) → `accounts` 테이블에서
`(provider, identifier)`로 계정 조회 → 자체 JWT 발급.

Response **200**:
```json
{ "token": "<jwt>", "token_type": "Bearer", "expires_in": 86400 }
```
에러: 400 `invalid_request`(JSON 아님/provider 불량/access_token 없음),
401 `unauthorized`(provider 거부 또는 계정 없음), 500 `server_error`.
GET 등 다른 메서드 → 405 + `Allow: POST`.

### 2.5 공통 라우트

- `GET /`, `GET /help` → **200**, HELP JSON (`{ name, endpoints: [{method, path, description}...] }`).
- 미지의 경로 → **404** `not_found` / "Endpoint not found".
- 핸들러 내부 미처리 예외 → **500** `server_error` / "An unexpected error occurred".
- `JWT_SECRET` 미설정(manager 한정) → **500** "Server configuration error".

### 2.6 Pagination (list 계열 공통)

- Query: `offset`(정수 ≥ 0), `limit`(정수 1–100). 위반 시 **400** `invalid_request`.
- Response envelope: `{ data: Row[], total: number, offset: <요청값|0>, limit: <요청값|20> }`.
- 정렬: `created_at` 내림차순. DB 계층 기본값 offset 0 / limit 20 (scheduler 계열은 limit 100 상한 clamp).
- **차이점(엣지)**: scheduler-manager는 `?offset=`(빈 문자열)을 "미지정"으로 무시(`trim()` 체크),
  crawler-manager는 `Number('') === 0`으로 offset 0으로 해석한다.

---

## 3. crawler-manager-worker

`WorkerEntrypoint` 클래스 (Service Binding RPC 제공). wrangler: `audio-underview-crawler-manager-worker`.

Environment: `ALLOWED_ORIGINS`(var), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`,
`CODE_RUNNER_FUNCTION_URL` (secrets). 의존성: `safe-regex2@^5.1.0` (이 worker에만 존재).

### 3.1 Endpoint 목록

| Method | Path | Auth | 설명 |
|---|---|---|---|
| GET | `/`, `/help` | – | HELP JSON |
| POST | `/authentication/token` | – | §2.4 |
| POST | `/crawlers` | JWT | 생성 → **201** CrawlerRow |
| GET | `/crawlers?offset&limit` | JWT | 목록 → **200** envelope |
| GET | `/crawlers/:id` | JWT | 단건 → **200** CrawlerRow / **404** |
| PUT | `/crawlers/:id` | JWT | **전체 교체** (create와 동일 검증) → **200** / **404** |
| DELETE | `/crawlers/:id` | JWT | → **200** `{ "deleted": true }` / **404** |

- `:id`는 정규식 `^\/crawlers\/([0-9a-f-]+)$`(case-insensitive)로 추출 후 UUID 패턴
  `^[0-9a-f]{8}-...-[0-9a-f]{12}$/i` 검증. 불일치 → **404** "Invalid crawler ID format".
- `/crawlers` 경로에서 허용 외 메서드 → **405** + `Allow: GET, POST, PUT, DELETE, OPTIONS`.
- 소유권: GET/PUT/DELETE 모두 `user_uuid = JWT.sub` 조건이 쿼리에 포함 —
  타인 소유는 **404** ("Crawler not found" / "Crawler not found or not owned by you").

### 3.2 Create/Update body 검증 (validateCrawlerBody — 순서 그대로)

```typescript
interface CreateCrawlerRequestBody {
  name: string;                            // required, non-empty(trim), ≤ 255
  type?: 'web' | 'data';                   // default 'web'
  url_pattern?: string;                    // web이면 required; ≤ 2048; safe-regex2 통과; new RegExp 컴파일 가능
  code: string;                            // required, non-empty(trim), ≤ 1_048_576 (1MB)
  input_schema?: Record<string, unknown>;  // data면 required, plain object (배열/null 불가)
  output_schema?: Record<string, unknown>; // optional, plain object
}
```

검증 실패는 전부 **400** `invalid_request` + 필드별 메시지. 주요 메시지 원문:
- `"Field 'name' is required and must be a non-empty string"`
- `"Field 'type' must be 'web' or 'data'"`
- `"Field 'url_pattern' is required for web crawlers"`
- `"Field 'url_pattern' contains potentially unsafe regex pattern"` ← **safe-regex2** (ReDoS 방지)
- `"Field 'url_pattern' must be a valid regex"`
- `"Field 'input_schema' is required for data crawlers and must be a JSON object"`
- 길이 초과: `"Field 'X' must not exceed N characters"`

정규화(서버가 수행): `type` 기본값 채움; **web이면 `input_schema = { body: 'string' }` 강제**;
저장 시 data면 `url_pattern = null`.

### 3.3 safe-regex2 사용처 (총 2곳)

1. `validateCrawlerBody` — 생성/수정 시 `url_pattern` ReDoS 검사, 실패 시 400 거부.
2. `crawler-executor.ts executeCrawler` — 실행 시점 재검사. unsafe면 **거부하지 않고**
   url_pattern 매칭 검증만 skip + `warn` 로그.

래퍼: `sources/safe-url-pattern.ts` → `isSafeURLPattern(pattern) = isSafeRegex(pattern)`.

### 3.4 Service Binding RPC — `executeCrawler(crawlerID, input)`

scheduler-manager 전용 진입점. **사용자 소유권 검사 없음** (binding 선언 자체가 접근 제어).

```typescript
async executeCrawler(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult>
// CrawlerExecuteResult = { type: 'web' | 'data', result: unknown }   ← mode 없음에 주의
```

흐름 (crawler-executor.ts):
1. `getCrawlerByID` (ownership 무시 조회). 없으면 `throw Error("Crawler <id> not found")`.
2. `type === 'web'`:
   - URL 결정: ① `input.url`이 non-empty string이면 사용 → ② `crawler.input_schema.url.default`
     (non-empty string) → ③ 없으면 `throw Error("Crawler <id>: no URL available. Provide url in input or set a default in input_schema.")`
   - `url_pattern` 존재 시: unsafe regex → 검증 skip+warn; URL 불일치 → **warn만 하고 실행은 계속**;
     regex 컴파일 실패 → warn.
   - `codeRunnerClient.run('web', url, undefined, code)` 호출.
3. `type === 'data'`: `codeRunnerClient.run('data', undefined, input, code)`.
4. 반환: `{ type, result: response.result }`.

### 3.5 HTTPCodeRunnerClient (code-runner-client.ts) — 재시도 계약

- 대상: `POST {CODE_RUNNER_FUNCTION_URL}/run`, `Content-Type: application/json`.
- Request body: web → `{ type:'web', mode:'run', url, code }`, data → `{ type:'data', mode:'run', data, code }`.
  **manager 경유 실행은 항상 `mode:'run'`.**
- 요청당 timeout **30초** (`AbortSignal.timeout`).
- 재시도: 최대 2회 (총 3회 시도). 대상 = 네트워크 에러, 5xx. backoff = 1s, 2s (1000·2^(n-1)).
- **4xx는 재시도 없이 즉시 실패** (사용자 코드 에러로 간주).
- 성공(2xx) 응답은 `validateCodeRunnerResult`로 검증: object + `type ∈ {web,data}` +
  `mode ∈ {test,run}` + `result` 키 존재. 위반 시 `CodeRunnerExecutionError('invalid_response', ...)`.
- 실패 시 던지는 예외: `CodeRunnerExecutionError { errorCode, errorDescription, statusCode }`,
  message = `` `CodeRunner error ${statusCode}: [${errorCode}] ${errorDescription}` ``.
- **알려진 quirk**: 4xx 에러 body 파싱 시 `error_code` 필드를 찾지만 runner는 `error` 필드로
  응답하므로 errorCode는 항상 fallback `'execution_error'`가 된다. `error_description`은 전달됨.
  재작성 시 필드명 통일 필요.

---

## 4. scheduler-manager-worker

plain `{ fetch }` handler. wrangler: `audio-underview-scheduler-manager-worker`.
Environment: `ALLOWED_ORIGINS`(var), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`(secrets),
`CRAWLER_MANAGER`(service binding → crawler-manager-worker).

### 4.1 Endpoint 목록

| Method | Path | 응답 | 405 Allow |
|---|---|---|---|
| GET | `/`, `/help` | HELP JSON | |
| POST | `/authentication/token` | §2.4 | POST |
| POST | `/schedulers` | **201** SchedulerRow | GET, POST |
| GET | `/schedulers?offset&limit` | **200** envelope | |
| GET | `/schedulers/:id` | **200** / **404** | GET, PUT, DELETE |
| PUT | `/schedulers/:id` | **200** / **404** (부분 업데이트) | |
| DELETE | `/schedulers/:id` | **200** `{deleted:true}` / **404** | |
| POST | `/schedulers/:id/stages` | **201** StageRow | GET, POST |
| GET | `/schedulers/:id/stages` | **200** `{ data: StageRow[] }` (stage_order asc, envelope에 total 없음) | |
| GET | `/schedulers/:id/stages/:stageID` | **200** / **404** | GET, PUT, DELETE |
| PUT | `/schedulers/:id/stages/:stageID` | **200** / **404** (부분 업데이트) | |
| DELETE | `/schedulers/:id/stages/:stageID` | **200** `{deleted:true}` / **404** | |
| PUT | `/schedulers/:id/stages/reorder` | **200** `{ data: StageRow[] }` | PUT |
| GET | `/schedulers/:id/runs?offset&limit` | **200** envelope | GET |
| GET | `/schedulers/:id/runs/:runID` | **200** RunRow / **404** | GET |
| POST | `/schedulers/:id/execute` | §4.5 | POST |

- 라우팅: 정규식 기반 `parseRoute`. path segment가 `[0-9a-f-]+`인데 UUID 패턴 불일치 →
  route type `null` → **404** "Invalid resource path".
- `/schedulers/:id/stages/reorder`가 `stage_single` 패턴보다 **먼저** 매칭됨 (reorder는 예약어).
- 모든 하위 리소스 핸들러는 진입 시 `verifySchedulerOwnership` (getScheduler with user_uuid) —
  실패 시 **404** "Scheduler not found". 이 검사가 body 파싱보다 **먼저** 수행된다.

### 4.2 Scheduler body 검증

Create (`POST /schedulers`):
```typescript
{
  name: string;              // required, non-empty(trim), ≤ 255
  cron_expression?: string;  // optional, ≤ 100, isValidCronExpression 통과
  is_enabled?: boolean;      // optional
}
```
Update (`PUT /schedulers/:id`): 세 필드 모두 optional이되 **최소 1개 필수**
(아니면 400 "At least one field must be provided for update"). `cron_expression: null` 허용(해제).

**Cron 검증** (`handlers/tools.ts isValidCronExpression`): 표준 5필드
`분(0-59) 시(0-23) 일(1-31) 월(1-12) 요일(0-7)`. 각 필드는 `*`, `*/step`, 값, 값-범위,
`,` 리스트, `값/step` 허용. 범위는 start ≤ end 여야 함. 필드 수 ≠ 5 → 불합격.
(정규식 5개 하드코딩 — 소스 `CRON_FIELD_PATTERNS` 참조.)

### 4.3 Stage body 검증

Create (`POST /schedulers/:id/stages`):
```typescript
{
  crawler_id: string;                       // required, UUID 형식
                                            // + getCrawlerPermission(crawler_id, user) 존재해야 함
                                            //   없으면 403 forbidden "You do not have permission to use this crawler"
  stage_order: number;                      // required, 정수 ≥ 0
  input_schema: Record<string, unknown>;    // required, plain object
  output_schema?: Record<string, unknown>;  // optional, plain object
  fan_out_field?: string;                   // optional, non-empty(trim)
  fan_out_strategy?: 'compact' | 'preserve';// optional
}
```
Update (`PUT .../stages/:stageID`): 모두 optional + 최소 1개. `fan_out_field: null` 허용(해제).
`crawler_id` 변경 시에도 permission 검사 수행.

DB 에러 매핑 (create/update 공통, 에러 메시지 문자열 매칭):
- unique 위반(`unique`/`UNIQUE`/`23505`) → **409** `conflict`
  ("A stage with this order already exists" / update는 "...this configuration...")
- FK 위반(`RESTRICT`/`23503`/`violates foreign key`) → **400** "Referenced crawler does not exist"
- 그 외 → rethrow → 500.

### 4.4 Stage reorder — `PUT /schedulers/:id/stages/reorder`

Request: `{ stage_ids: string[] }` — non-empty, 전원 UUID, **중복 금지** (Set 크기 비교).
위반 시 400 (메시지 3종: required/each element/duplicates).

실행: Supabase RPC `reorder_scheduler_stages(p_scheduler_id, p_stage_ids)` (migration 005):
- `UNIQUE(scheduler_id, stage_order)`는 `DEFERRABLE INITIALLY DEFERRED`로 교체되어 있어
  트랜잭션 내 일시적 중복 허용 (PostgREST가 RPC를 트랜잭션으로 감쌈).
- 함수 내부 검증: 배열 비어있으면 RAISE; **distinct 개수 ≠ 해당 scheduler의 stage 총수면 RAISE**
  (부분 reorder 불가 — 전체 stage id를 순서대로 모두 보내야 함).
- 배열 순서대로 `stage_order = index(0-based)` 재할당 후 전체 stage를 order asc로 반환.
- SQL 예외 → worker에서 메시지 매칭(`mismatch|unknown|not found|validation|23503|violates`)
  → **400** "Stage reorder validation failed", 그 외 rethrow → 500.

Response **200**: `{ data: SchedulerStageRow[] }` (재정렬 후 전체).

### 4.5 실행 — `POST /schedulers/:id/execute` (동기 실행; body 없음)

`handlers/scheduler-execution.ts handleExecuteScheduler`:

1. ownership 검사 (404).
2. `createSchedulerRun({ scheduler_id, status: 'pending' })`.
   unique index 위반 메시지에 `scheduler_runs_one_active_per_scheduler` 포함 시 →
   **409** `{ "error": "conflict", "error_description": "A run is already in progress" }`.
3. `Promise.race([ executeScheduler(...), 5분 timeout reject ])`
   (`PIPELINE_TIMEOUT_MILLISECONDS = 300_000`).
4. timeout 발생 시: `abortController.abort()` 후 run을
   `{ status:'failed', completed_at, error: "Pipeline execution timed out after 5 minutes" }`로 갱신 —
   단 `onlyIfStatus: ['pending','running']` 조건부 (executor가 이미 종료 상태를 썼다면 덮어쓰지 않음).
5. 최종 run을 다시 조회해 응답:

```typescript
// Response body (HTTP status는 resolveHTTPStatus로 결정)
{
  run_id: string, status: SchedulerRunStatus,
  result: unknown, error: string | null,
  started_at: string | null, completed_at: string | null,
}
```

**resolveHTTPStatus(status, error)** — 테스트로 고정된 매핑:

| 조건 | HTTP |
|---|---|
| `completed`, `partially_failed`, `pending`, `running`, `failed`+error null | 200 |
| `failed` + error에 `'timed out'` 포함 | 408 |
| `failed` + `'Invalid input_schema'` 또는 `'fan_out_field'` 포함 | 422 |
| `failed` + `'CodeRunner error'` 또는 `'Invalid CrawlerExecuteResult'` 포함 | 502 |
| `failed` + `'Supabase'` 또는 `'database'` 포함 | 503 |
| `failed` + 그 외 | 500 |

### 4.6 Executor 시맨틱 (scheduler-executor.ts)

```
executeScheduler(deps, schedulerID, userUUID, runID, signal?)
```

1. run → `{ status:'running', started_at: now }`.
2. `listSchedulerStages` (stage_order asc). **빈 파이프라인**이면 run →
   `{ status:'completed', completed_at, result: null }` 후 종료.
3. 첫 stage 입력 = `resolveDefaultInput(stages[0].input_schema)`:
   input_schema가 object 아니면 `throw "Invalid input_schema: expected object, got <type>"`;
   각 key의 값이 object이고 `default` 키가 있으면 `defaults[key] = value.default`
   (null/false 등 falsy default도 보존). 그 외 필드는 무시 → 결과는 defaults만 담긴 object.
4. stage 순회 (`for`, 순차). 각 반복 시작 시 `signal.aborted`면 break.
   - **fan-out stage** (`fan_out_field` 설정 시):
     a. 현재 input이 object가 아니면(문자열/숫자 등) throw
        `` `Stage ${order}: fan_out_field "${f}" requires object input, got ${typeof}` `` → run failed.
     b. `input[fan_out_field]`가 undefined/null → throw `"... not found in input"`;
        배열 아님 → throw `"... is not an array"`.
     c. stage_run 생성 `{ status:'running', started_at, input }`.
     d. 빈 배열이면 stage_run → completed, `output: [], items_*: 0` — 다음 stage input `[]`.
     e. `executeFanOut(deps, stage, items, concurrency=1, signal)` — §4.7.
     f. stage_run 갱신: `{ status, completed_at, output: results, items_total/succeeded/failed }`.
     g. fan-out status `failed`(전원 실패) → throw `` `Stage ${order}: all fan-out items failed` `` → run failed.
        `partially_failed` → `hasPartialFailure = true`, 파이프라인 계속.
     h. 다음 stage input = `results` 배열.
   - **일반 stage**: `executeStage` — §4.7. output이 다음 stage의 input (chaining).
5. 종료 처리:
   - 정상 완료: run → `{ status: hasPartialFailure ? 'partially_failed' : 'completed', completed_at, result: lastOutput }`.
   - 예외: run → `{ status:'failed', completed_at, error: message }` (갱신 실패는 로그만, rethrow 안 함).
   - `finally`: **항상** `updateScheduler(schedulerID, userUUID, { last_run_at: now })`
     (실패해도 로그만). 단 `signal.aborted`면 위 3가지 쓰기 모두 skip (timeout 후 late-write 방지).

### 4.7 Stage runner (stage-runner.ts)

**executeStage(deps, runID, stage, input, signal?)**:
- aborted면 즉시 throw `'Stage execution aborted: pipeline timed out'`.
- stage_run 생성 `{ run_id, stage_id, stage_order, status:'running', started_at, input }`.
- `crawlerExecutionClient.execute(stage.crawler_id, input)` 호출
  (= Service Binding RPC → crawler-manager.executeCrawler → validateCrawlerExecuteResult).
- 성공: stage_run → `{ status:'completed', completed_at, output: response.result }`.
  update가 null 반환하면 원본 stageRun으로 fallback. 반환 `{ output, stageRun }`.
- 실패: stage_run → `{ status:'failed', completed_at, error }` (이 update 실패는 로그만) 후 **rethrow**.

**executeFanOut(deps, stage, items, concurrency=1, signal?)**:
- worker-pool 패턴이나 현재 항상 **concurrency 1 = 순차 실행**.
- item별 `execute(stage.crawler_id, item)`. 실패 item은 `warn` 로그 + `itemsFailed++`
  (개별 stage_run은 만들지 않음 — 카운터만).
- 결과 status: 실패 0 → `completed`; 일부 성공 → `partially_failed`; 전원 실패 → `failed`.
- 결과 배열: sentinel `FAN_OUT_FAILED` Symbol로 실패 슬롯 표시 후 전략 적용 —
  `compact`(기본): 실패 슬롯 제거; `preserve`: 실패 슬롯을 `null`로 치환 (index 보존).
  성공 결과가 `null`인 경우도 보존됨 (Symbol 비교이므로 null과 구분).
- 반환 `{ results, itemsTotal, itemsSucceeded, itemsFailed, status }`.

### 4.8 crawler-execution-client.ts

```typescript
interface CrawlerExecutionClient { execute(crawlerID, input): Promise<CrawlerExecuteResult> }
class ServiceBindingCrawlerExecutionClient // binding.executeCrawler(...) 호출 후
                                           // validateCrawlerExecuteResult(raw)로 검증
// 검증: object + type ∈ {web,data} + 'result' in record. 실패 메시지 prefix "Invalid CrawlerExecuteResult: ..."
```

### 4.9 Cron / scheduled event — **미구현**

- `scheduled()` handler 없음, wrangler.toml에 `[triggers] crons` 없음. 전 repo grep 결과 0건.
- `cron_expression`, `is_enabled`는 현재 **검증 + 저장만 되는 메타데이터**.
  실행은 `POST /schedulers/:id/execute` (수동) 뿐.
- 재작성 시: cron 자동 실행을 붙인다면 `is_enabled` 게이트 + 동시 실행 방지 index를 그대로 활용 가능.

---

## 5. Code Runner — worker vs function

### 5.1 공통 HTTP 계약 (`POST /run`, 인증 없음)

Request:
```typescript
type RunRequestBody =
  | { type: 'web';  mode: 'test' | 'run'; url: string;   code: string }
  | { type: 'data'; mode: 'test' | 'run'; data: unknown; code: string };
// code: "JavaScript function source" — "(input) => {...}" 형태의 함수 표현식
```
검증 순서(양쪽 동일): JSON 파싱 → `type` → `mode` → `code`(string) → web이면 `url`(string) /
data면 `'data' in body` (값이 null이어도 키만 있으면 통과) → `code.length ≤ 10_000`
(**MAX_CODE_LENGTH = 10_000** — crawler-manager의 1MB 제한과 불일치, §8 참조) →
web이면 `new URL(url)` 파싱.
전부 **400** `invalid_request`.

Response **200**:
```typescript
{ type: 'web'|'data', mode: 'test'|'run', result: unknown }
// 주의: 사용자 코드가 undefined를 반환하면 JSON.stringify가 result 키를 생략한다 (테스트로 고정된 동작)
```

`mode`는 실행 동작에 아무 영향 없음 — 요청 값을 그대로 에코. 관례: frontend 에디터 = `test`,
manager 파이프라인 = `run`.

에러 status: 400 `invalid_request` / 404 `not_found` / 405 (+`Allow: POST`) /
422 `execution_failed`·`execution_timeout`(function만) / 502 `fetch_failed` /
504 `fetch_timeout` / 413 `response_too_large`(worker만) / 500 `server_error`.

web 흐름: host가 `fetch(url, { signal: AbortSignal.timeout(10_000) })` → `response.text()` →
그 **텍스트**를 사용자 함수의 유일한 인자로 전달. (HTTP status와 무관하게 body 사용;
non-2xx도 실행됨.)
data 흐름: `data` 값을 그대로(또는 재직렬화 후) 인자로 전달.

### 5.2 crawler-code-runner-worker (Cloudflare, `workers/crawler-code-runner-worker/`)

- Environment: `ALLOWED_ORIGINS`(var) + `LOADER` (`[[worker_loaders]]` binding — CF Worker Loader beta).
- 실행 방식 (`create-code-runner.ts`): 요청마다 **동적 격리 worker isolate** 생성:
  ```javascript
  loader.get(`run-${crypto.randomUUID()}`, () => ({
    compatibilityDate: '2025-11-25',
    mainModule: 'runner.js',
    modules: { 'runner.js': `
      import { WorkerEntrypoint } from 'cloudflare:workers';
      export class Runner extends WorkerEntrypoint {
        async execute(data) { const fn = (${code}); return await fn(data); }
      }` },
    globalOutbound: null,     // ← 사용자 코드의 모든 outbound fetch 차단
  }))
  ```
  `worker.getEntrypoint('Runner').execute(input)` RPC로 실행.
- 보안 경계: **`globalOutbound: null`** = user code에서 네트워크 완전 차단.
  코드는 `(${code})`로 템플릿 삽입 — isolate 격리에 의존 (문자열 escape 없음).
- 제한: fetch timeout 10s (host 측), `MAX_RESPONSE_BYTES = 10MB`
  (**Content-Length 헤더로만 검사** — 헤더 없는 chunked 응답은 통과) → 초과 시 413.
  **사용자 코드 실행 timeout 없음** (CF isolate CPU 제한에 의존).
- 실행 예외 → 422 `execution_failed` / "Code execution failed" (상세 메시지 비노출).
- SSRF 방어 없음 (CF Workers의 fetch는 자체적으로 내부망 접근이 제한되는 환경 전제).

### 5.3 crawler-code-runner-function (AWS Lambda, `functions/crawler-code-runner-function/`)

- 진입: `export async function handler(event: LambdaEvent): Promise<LambdaResponse>`
  (Lambda Function URL v2 이벤트 형식; `isBase64Encoded` body 지원).
  빌드: esbuild bundle → `outputs/index.mjs` (node22, ESM, minify).
- Environment: `process.env.ALLOWED_ORIGINS`.
- **SSRF 방어 (web type 전용, data type은 검사 안 함)** — `validateTargetURL`:
  - 프로토콜 http/https만 허용 (아니면 400).
  - `dns.lookup(hostname, { all: true })` 후 **모든** resolve 주소를 `BLOCKED_IP_RANGES`와 대조:
    loopback(127./::1), RFC1918(10., 172.16-31., 192.168.), link-local(169.254./fe80:),
    0., unique-local IPv6(fc00:/fd00::/8), IPv4-mapped IPv6(::ffff:127. 등) → 하나라도 걸리면 400
    `"The resolved address for '<host>' is not allowed"`.
  - DNS 실패 → 502 `fetch_failed`.
  - (참고: lookup과 fetch가 별도 호출 — DNS rebinding TOCTOU 여지 있음.)
- 실행 방식 (`executeInSandbox`): **`node:vm` Script + createContext**.
  - Sandbox globals allowlist: `Array Boolean Date Error JSON Map Math Number Object Promise
    RegExp Set String TypeError RangeError URL URLSearchParams parseInt parseFloat isNaN isFinite
    encodeURIComponent decodeURIComponent encodeURI decodeURI undefined NaN Infinity`.
    → `fetch`, `require`, `process`, timer 등 **없음** (네트워크/FS/프로세스 접근 불가).
  - 비문자열 인자는 sandbox 컨텍스트 내부에서 `JSON.parse`로 재생성 —
    sandbox 내 `Array.isArray`/`instanceof`가 올바르게 동작하도록 (테스트로 고정).
  - timeout 2중: `new Script('(' + code + ')')` 평가+동기 실행에 vm `timeout: 5_000`;
    async 함수는 `Promise.race`로 5초 (`timer.unref()`).
  - timeout → 422 `execution_timeout` / `"Code execution timed out after 5000ms"`;
    기타 예외 → 422 `execution_failed` / **원본 에러 메시지 노출** (worker와 다름).
- 응답 크기 제한 없음 (worker의 10MB 검사 없음).

### 5.4 역할 차이 요약과 재작성 판단

| 항목 | worker (CF) | function (Lambda) |
|---|---|---|
| 격리 | Worker Loader 동적 isolate | node:vm 컨텍스트 |
| user code 네트워크 | `globalOutbound: null`로 차단 | sandbox에 fetch 미제공으로 차단 |
| SSRF(host fetch) | 없음 | DNS resolve + private range 차단 |
| 코드 실행 timeout | 없음 (isolate 한도 의존) | 5s (sync vm timeout + async race) |
| 응답 크기 | 10MB (Content-Length 기반) | 없음 |
| 에러 메시지 | 고정 문구 | 원본 메시지 노출 |
| 422 에러 코드 | `execution_failed`만 | `execution_failed` + `execution_timeout` |
| 실 소비자 | **없음** | frontend(`VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`, mode test) + crawler-manager(`CODE_RUNNER_FUNCTION_URL`, mode run) |

**판단**: HTTP 계약이 사실상 동일하고(요청/응답/에러 코드 대부분 일치) 현재 배선상 function만
사용된다. 이중화는 "동일 계약의 CF 대체 구현" 성격 — 재작성 시 **하나로 통합 가능**.
통합 시 반드시 합쳐야 할 초집합: SSRF 검사 + 5s 실행 timeout + 응답 크기 제한 +
`execution_timeout` 에러 코드 + undefined result 생략 동작 + base64 body(런타임이 Lambda일 때).
소비자 측 계약(§3.5 client의 30s/재시도/4xx 즉시 실패)은 그대로 유지.

---

## 6. 테스트가 고정하는 행위 계약 (엣지 케이스 카탈로그)

### crawler-manager (`tests/index.test.ts`, 825줄 / `tests/crawler-executor.test.ts`, 206줄)

- OPTIONS: 허용 origin → 204+CORS; 미허용 origin → 204 (CORS 헤더 없음).
- 인증: Authorization 없음 / 토큰 무효 / **만료 JWT** / **다른 secret으로 서명된 JWT** → 전부 401.
- 토큰 교환: Google·GitHub 성공 경로, provider 누락/무효/access_token 누락/비JSON → 400,
  provider가 토큰 거부 → 401, **계정 미존재 → 401**.
- 생성 검증: 비JSON/이름 누락/**공백만 있는 이름**/이름 255 초과/**무효 regex**/**ReDoS regex 거부**/
  무효 type/web에 url_pattern 없음/data에 input_schema 없음/output_schema가 object 아님 → 400.
- 목록: offset·limit 정상 통과, 음수 offset/0 limit/101 limit/**비숫자 offset**/**비정수 limit** → 400.
- 단건/수정/삭제: **타인 소유 → 404** (403 아님). PUT은 create와 동일한 필수 필드 검증.
- **무효 UUID 형식 → 404** (GET/PUT/DELETE 모두).
- executor: input.url 우선 / input_schema.url.default fallback / URL 없으면 throw /
  **url_pattern 불일치는 warn만 하고 실행 계속** / unsafe regex는 검증 skip+warn /
  data type은 input 그대로 전달 / client 에러는 그대로 전파.
- `validateCodeRunnerResult`: null·비object·type 무효·**mode 무효**·result 키 없음 → throw;
  `result: null`은 유효.

### scheduler-manager (`tests/index.test.ts`, 658줄)

- scheduler CRUD 정상 경로 + 404들. stage 생성 시 crawler_id 누락 → 400,
  scheduler 미존재 → 404 (body 검증 이전에).
- reorder: 정상 200 / stage_ids 누락·빈 배열·비UUID·**중복** → 400 / scheduler 미존재 404 /
  GET → 405.
- 무효 UUID 경로 → 404, `/authentication/token`에 GET → 405.

### scheduler-execution (`tests/scheduler-execution.test.ts`, 88줄)

- `resolveHTTPStatus` 전체 매핑 표 (§4.5) + `validateCrawlerExecuteResult` 검증 규칙.

### scheduler-executor (`tests/scheduler-executor.test.ts`, 604줄)

- 빈 stage 목록 → completed, `result: null`.
- 단일 stage → completed + output 저장.
- **multi-stage chaining: stage N output === stage N+1 input**.
- fan-out: field 존재+배열 검증 / **빈 배열 → completed, output `[]`** /
  전원 실패 → run failed / 일부 실패 → run `partially_failed` /
  **field 미존재 → throw** / **비배열 값 → throw**.
- stage throw → run failed.
- **last_run_at은 finally에서 항상 갱신**.
- run 상태 갱신 자체가 실패해도 throw하지 않고 로그만.

### stage-runner (`tests/stage-runner.test.ts`, 420줄)

- `resolveDefaultInput`: `{k:{default:v}}` 추출 / default 없는 필드 skip / 빈 schema → `{}` /
  비object 필드값 무시 / **default가 null·false여도 보존**.
- `executeStage`: running→completed 순서로 stage_run 기록 / 실패 시 failed 기록 후 rethrow /
  crawler_id 전달 확인 / **update가 null 반환 시 원본 stageRun fallback**.
- `executeFanOut`: 순차 실행 / completed·partially_failed·failed 판정 /
  **성공 결과가 null이어도 보존(compact에서 제거 안 됨)** / 빈 배열 처리 /
  실패 item마다 warn 로그 / item마다 올바른 crawler_id.

### code-runner worker (`tests/index.test.ts`, 552줄)

- 검증 400 계열 전체(type/mode/url/data/code 누락·무효, code 길이 초과, 무효 URL).
- fetch 실패 → 502. 실행 throw/문법 오류 → 422.
- web·data 각각: object/array/string/null 데이터, async 코드, mode test·run 에코.
- 405 + 404.

### code-runner function (`tests/index.test.ts`, 698줄) — worker와 겹치는 것 외 추가

- **base64 인코딩 body 처리**.
- **undefined 반환 시 응답에서 `result` 키 생략** (web·data 모두).
- **sandbox 내 `Array.isArray(array data) === true` 보장**.
- **data type은 SSRF 검사를 하지 않음**.

### worker-tools (`tests/`)

- JWT: sign→verify 왕복, wrong secret/만료/malformed/**변조 payload** → null, custom claim 보존.
- CORS: 빈 origin/미허용 origin → 헤더 없음, 특정 origin → credentials 포함, `*` → credentials 없음.
- responses: `{error, error_description}` 구조, redirect fallback (invalid frontend URL → 400 JSON).

---

## 7. 공용 유틸 인벤토리

### 7.1 `workers/tools` → `@audio-underview/worker-tools`

| Export | 기능 |
|---|---|
| `ResponseContext` | `{ origin, allowedOrigins, logger }` — 모든 응답 헬퍼의 컨텍스트 |
| `jsonResponse(data, status, context)` | CORS+`Content-Type: application/json` 포함 `Response` |
| `errorResponse(error, description, status, context)` | `{error, error_description}` + error 로그 |
| `redirectToFrontendWithError(frontendURL, error, desc, logger)` | 302 redirect(쿼리에 에러) / URL 무효 시 400 JSON fallback |
| `createCORSHeaders(origin, allowedOrigins, logger)` | §2.2 (`Headers` 반환) |
| `handleOptions(request, environment, logger)` | 204 preflight |
| `signJWT(payload, secret)` / `verifyJWT(token, secret)` / `JWTPayload` | HS256 자체 구현 (§2.3) |
| `CrawlerExecuteResult` / `validateCrawlerExecuteResult(value)` | RPC 결과 계약 `{type, result}` + 런타임 검증 |
| `createOAuthWorkerHandler(options)` | OAuth worker 공통 라우터 (`/authorize`, `/callback`, `/health`) — 이 도메인 밖 |
| `validateCallbackParameters(url, ...)` / `verifyState(state, kv, ...)` | OAuth callback 검증 — 이 도메인 밖 |
| types: `OAuthErrorResponse`, `OAuthProvider`, `BaseEnvironment`, `OAuthWorkerHandlers/Options` | |

### 7.2 `functions/tools` → `@audio-underview/function-tools`

worker-tools의 Lambda 버전 (Response 대신 `LambdaResponse`, `Headers` 대신 `Record<string,string>`):
- `LambdaEvent` (Function URL v2 형태: `requestContext.http.{method,path}`, `headers`, `body`,
  `isBase64Encoded`), `LambdaResponse { statusCode, headers, body }`, `ResponseContext`,
  `ErrorResponseBody`.
- `jsonResponse` / `errorResponse` / `createCORSHeaders` — 시그니처·시맨틱 worker-tools와 동일.
- JWT·OAuth 헬퍼 없음.

### 7.3 `packages/logger` → `@audio-underview/logger`

- `type LogLevel = 'debug' | 'info' | 'warn' | 'error'`; `LOG_LEVEL_VALUES` (debug 0 … error 3).
- `LoggerOptions { minimumLevel?, includeTimestamp?, includeLevel?, formatAsJSON?, defaultContext?, enabled? }`.
- `LogContext` — `{ module?, function?, metadata? ... }` 형태의 구조화 컨텍스트.
- `class Logger`:
  - `debug/info/warn(message, data?, context?)`, `error(message, error?, context?)`
  - `createChild(context)` — 컨텍스트 병합된 자식 logger.
- Factories: `createBrowserLogger`, `createWorkerLogger` (JSON 포맷), `createServerLogger`,
  `createAutoLogger` (환경 자동 감지), `getLogLevelFromEnvironment`.
- 사용 관례: worker는 `createWorkerLogger({ defaultContext: { module: '<worker-name>' } })`,
  function은 `createServerLogger`. 호출 시 3번째 인자로 `{ function: '<fn>', metadata: {...} }`.

### 7.4 `packages/axiom-logger` → `@audio-underview/axiom-logger`

OpenTelemetry 기반 관측 계층 (Axiom 백엔드):
- `instrumentWorker(handler, configResolver)` — `@microlabs/otel-cf-workers`의 `instrument` 래핑.
  config: `AxiomLoggerConfiguration { token, dataset, serviceName?, axiomURL? }`
  (`DEFAULT_AXIOM_URL` 존재), `ConfigurationResolver<E> = (environment) => configuration`.
- `log.ts` — active span 기반 구조화 로그 헬퍼 (`@opentelemetry/api trace` 사용).
- tracers (`@audio-underview/axiom-logger/tracers` subpath export):
  - `withSpan(name, fn)` — span 생성/OK·ERROR status/recordException/end 자동 처리.
  - `getActiveSpan`, `addSpanEvent`, `setSpanAttribute`, `setSpanAttributes`, `setSpanError`.
  - `traceDatabaseOperation({ serviceName, operation, table }, fn)` — span 이름
    `db.<operation> <table>`; **supabase-connector의 모든 DB 함수가 이걸로 감싸져 있음**
    (관례: `db.query.*`/`db.insert.*`/`db.rows_affected` 등 attribute 설정).
  - re-export: `SpanStatusCode`, `Span` (`@opentelemetry/api`).

### 7.5 `packages/supabase-connector` (도메인 데이터 접근 계층)

`createSupabaseClient({ supabaseURL, supabaseSecretKey })` + 테이블별 함수.
공통 시맨틱: 조회류는 미존재 시 `undefined` (PostgREST `PGRST116` 흡수), 삭제는 `boolean`
(영향 행 수 > 0), 그 외 에러는 `Error("Failed to <verb> <entity>: <db message>")`로 throw.

- crawlers: `createCrawler`, `listCrawlersByUser(user, {offset,limit})`,
  `getCrawler(id, user)` (소유권), `getCrawlerByID(id)` (**소유권 무시 — 실행 엔진용**),
  `updateCrawler(id, user, input)`, `deleteCrawler(id, user)`.
- crawler-permissions: `createCrawlerPermission`, `getCrawlerPermission(crawlerID, userUUID)`
  (`maybeSingle`), `deleteCrawlerPermission`.
- schedulers: `createScheduler`, `listSchedulersByUser` (limit 100 clamp), `getScheduler`,
  `updateScheduler`, `deleteScheduler`.
- scheduler-stages: `createSchedulerStage`, `listSchedulerStages(schedulerID)` (order asc),
  `getSchedulerStage(id, schedulerID)`, `updateSchedulerStage`, `deleteSchedulerStage`,
  `reorderSchedulerStages(schedulerID, stageIDs)` (RPC, §4.4).
- scheduler-runs: `createSchedulerRun`, `getSchedulerRun(id, schedulerID)`,
  `updateSchedulerRun(id, schedulerID, input, { onlyIfStatus? })` (**조건부 상태 갱신** — timeout race 방지),
  `listSchedulerRuns` (limit 100 clamp).
- scheduler-stage-runs: `createSchedulerStageRun`, `updateSchedulerStageRun(id, runID, input)`,
  `listSchedulerStageRunsByRun(runID)` (stage_order asc).

마이그레이션 (계약에 영향 주는 것):
`002` crawlers 테이블 / `003` crawler type·schemas 추가 / `004` schedulers·stages·runs·stage_runs +
`scheduler_run_status` enum + updated_at trigger / `005` DEFERRABLE unique + `reorder_scheduler_stages`
RPC / `006` active-run partial unique index / `007` crawler_permissions / `008` `fan_out_strategy`
enum + 컬럼 (default `compact`).

---

## 8. 재작성 시 주의할 불일치·함정 목록

1. **code 길이 제한 불일치**: crawler-manager는 1MB까지 저장 허용, code-runner는 10,000자에서 400.
   10K 초과 crawler는 저장은 되지만 실행이 항상 실패한다.
2. **client 에러 필드 quirk**: HTTPCodeRunnerClient는 `error_code`를 읽지만 runner는 `error`로
   응답 → errorCode가 항상 `execution_error`로 fallback (§3.5).
3. **`CrawlerExecuteResult`(RPC)와 `CodeRunnerResult`(HTTP)는 다른 타입** — 전자는 mode 없음,
   후자는 mode 필수. 검증기도 별도 (worker-tools vs code-runner-client).
4. **404 vs 403**: 리소스 소유권 실패는 일관되게 404 (정보 은닉). 403은 오직
   crawler permission 부재(stage 생성/수정) 한 곳.
5. **url_pattern은 실행 시 soft-check**: 저장 시엔 hard 검증(400), 실행 시엔 불일치/unsafe여도
   warn 후 실행 진행.
6. **cron 자동 실행 미구현** (§4.9) — API·DB만 존재.
7. **pagination 빈 문자열 처리 차이** (§2.6).
8. **scheduler-manager만 JWT sub UUID 형식 검사** (§2.3).
9. **fan-out 실패 item은 stage_run을 안 만든다** — 카운터(items_*)와 output 배열로만 관측 가능.
10. **run 응답의 HTTP status는 error 메시지 문자열 매칭으로 결정** (§4.5) — 에러 메시지 문구를
    바꾸면 status 코드 계약이 깨진다. (DB 에러→409/400 매핑도 동일하게 문자열 매칭.)
11. **worker 버전 code-runner는 미사용** — 삭제/통합 후보. 통합 시 function의 보안 기능이 초집합 기준.
12. **executor의 abort 시맨틱**: `signal.aborted` 이후에는 run/scheduler에 어떤 쓰기도 하지 않는다
    (timeout 핸들러가 쓴 `failed` 상태 보존). `onlyIfStatus: ['pending','running']` 가드와 이중 방어.
13. **stage 삭제와 crawler 삭제**: `crawler_id` FK가 `ON DELETE RESTRICT` — stage에서 사용 중인
    crawler를 DELETE하면 DB 에러 → 현재 crawler-manager는 이를 매핑하지 않아 **500**이 된다
    (테스트 없음; 재작성 시 409로 매핑 권장).
14. 사용자 코드 형태 계약: `code`는 **함수 표현식 문자열** (`(input) => ...` 또는
    `async function(input) {...}`). 실행부는 `(${code})`를 평가해 호출한다 —
    선언문(statement)이나 표현식이 아닌 코드는 문법 오류(422).
