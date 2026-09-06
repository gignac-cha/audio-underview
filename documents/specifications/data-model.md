# Data Model Specification (데이터 계약)

프로젝트 재작성 시 보존해야 하는 Supabase(Postgres) 데이터 모델 전체 스펙.
외부 Supabase 프로젝트에 실제 데이터가 존재하므로 **테이블/컬럼/enum/제약조건/인덱스/RPC 이름과 형태를 그대로 보존**해야 한다.

- 출처: `packages/supabase-connector/migrations/*.sql` (001–008, 총 322줄), `packages/supabase-connector/sources/`, `workers/*`
- 작성일: 2026-07-06
- 기준 커밋: `361283b` (main)

---

## 1. Migration 배포 메커니즘

- Workflow: `.github/workflows/deploy-database-migrations.yml`
- 트리거: `packages/supabase-connector/migrations/**` 변경 push (main) 또는 workflow_dispatch
- 적용 방식: Supabase Management API `POST https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_ID}/database/migrations`
  - body: `{ name, query }` (query = SQL 파일 원문 전체)
  - 이미 적용된 migration은 `GET`으로 조회한 name 목록과 비교해 skip
- **migration name 규칙**: 파일명에서 `.sql` 제거 후 첫 `_` 앞의 숫자 prefix를 제거 (`name="${filename#*_}"`)
  - 예: `001_create_users_and_accounts.sql` → `create_users_and_accounts`

**재작성 시 주의**: Supabase 쪽 migration registry에는 아래 8개 name이 이미 기록되어 있다.
같은 name을 유지하지 않으면 재적용 시도로 실패한다 (테이블 이미 존재).

| # | 파일 | 등록된 name |
|---|------|-------------|
| 001 | `001_create_users_and_accounts.sql` | `create_users_and_accounts` |
| 002 | `002_create_crawlers.sql` | `create_crawlers` |
| 003 | `003_add_crawler_type_and_schemas.sql` | `add_crawler_type_and_schemas` |
| 004 | `004_create_schedulers.sql` | `create_schedulers` |
| 005 | `005_add_reorder_scheduler_stages.sql` | `add_reorder_scheduler_stages` |
| 006 | `006_add_active_run_unique_constraint.sql` | `add_active_run_unique_constraint` |
| 007 | `007_create_crawler_permissions.sql` | `create_crawler_permissions` |
| 008 | `008_add_fan_out_strategy.sql` | `add_fan_out_strategy` |

필요 secrets/vars: `SUPABASE_ACCESS_TOKEN` (secret), `SUPABASE_PROJECT_ID` (var).

---

## 2. Enum 타입 (5개)

| Enum | 값 | 정의 migration |
|------|-----|----------------|
| `provider_type` | `google`, `github`, `apple`, `microsoft`, `facebook`, `x`, `linkedin`, `discord`, `kakao`, `naver` | 001 |
| `crawler_type` | `web`, `data` | 003 |
| `scheduler_run_status` | `pending`, `running`, `completed`, `failed`, `partially_failed` | 004 |
| `crawler_permission_level` | `owner`, `subscriber` | 007 |
| `fan_out_strategy` | `compact`, `preserve` | 008 |

---

## 3. 테이블 (8개) — 최종(effective) 스키마

모든 migration 적용 후의 최종 상태. FK 화살표: `A.col → B.col`.

### 3.1 `users`

통합 사용자 계정. 여러 social login account를 가질 수 있음.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `uuid` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

### 3.2 `accounts`

Social login 계정. user에 연결.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `provider` | `provider_type` | NOT NULL | | **PK (composite)** |
| `identifier` | `TEXT` | NOT NULL | | **PK (composite)**. provider별 고유 ID (Google `sub`, GitHub `id` 등) |
| `uuid` | `UUID` | NOT NULL | | FK → `users.uuid` `ON DELETE CASCADE` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

- PK: `(provider, identifier)`
- Index: `accounts_uuid_index ON accounts(uuid)`

### 3.3 `crawlers`

사용자 정의 crawler. 002에서 생성, 003에서 `type`/`input_schema`/`output_schema` 추가 및 `url_pattern` NULL 허용으로 변경.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `user_uuid` | `UUID` | NOT NULL | | FK → `users.uuid` `ON DELETE CASCADE` |
| `name` | `TEXT` | NOT NULL | | |
| `url_pattern` | `TEXT` | **NULL** (003에서 NOT NULL 해제) | | URL 매칭 regex. `type='data'`이면 null |
| `code` | `TEXT` | NOT NULL | | 실행할 JavaScript 코드 |
| `type` | `crawler_type` | NOT NULL | `'web'` | 003 추가. `web`: fetch 후 `code(body)` / `data`: `code(data)` 직접 실행 |
| `input_schema` | `JSONB` | NOT NULL | `'{"body": "string"}'` | 003 추가 |
| `output_schema` | `JSONB` | NOT NULL | `'{}'` | 003 추가 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | trigger로 자동 갱신 |

- Index: `crawlers_user_uuid_index ON crawlers(user_uuid)`
- Trigger: `crawlers_updated_at_trigger` BEFORE UPDATE → `update_crawlers_updated_at()` (`NEW.updated_at = NOW()`)

### 3.4 `schedulers`

Crawler를 stage로 체이닝하는 pipeline 정의.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `user_uuid` | `UUID` | NOT NULL | | FK → `users.uuid` `ON DELETE CASCADE` |
| `name` | `TEXT` | NOT NULL | | |
| `cron_expression` | `TEXT` | NULL | | 자동 실행 cron (optional) |
| `is_enabled` | `BOOLEAN` | NOT NULL | `true` | |
| `last_run_at` | `TIMESTAMPTZ` | NULL | | 최근 실행 시각 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | trigger로 자동 갱신 |

- Index: `schedulers_user_uuid_index ON schedulers(user_uuid)`
- Trigger: `schedulers_updated_at_trigger` BEFORE UPDATE → `update_schedulers_updated_at()`

### 3.5 `scheduler_stages`

Pipeline 내 stage. 004에서 생성, 005에서 UNIQUE 제약을 DEFERRABLE로 교체, 008에서 `fan_out_strategy` 추가.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `scheduler_id` | `UUID` | NOT NULL | | FK → `schedulers.id` `ON DELETE CASCADE` |
| `crawler_id` | `UUID` | NOT NULL | | FK → `crawlers.id` **`ON DELETE RESTRICT`** (사용 중인 crawler 삭제 차단) |
| `stage_order` | `INTEGER` | NOT NULL | | `CHECK (stage_order >= 0)`. 0-based 실행 순서 |
| `input_schema` | `JSONB` | NOT NULL | | JSON Schema + optional defaults. 예: `{ url: { type: "string", default: "https://..." } }` |
| `output_schema` | `JSONB` | NOT NULL | `'{}'` | crawler의 output_schema에서 파생 |
| `fan_out_field` | `TEXT` | NULL | | 이전 stage output에서 fan-out할 array field 이름 (null = fan-out 없음) |
| `fan_out_strategy` | `fan_out_strategy` | NOT NULL | `'compact'` | 008 추가. `compact`: 실패 item 제거 / `preserve`: 실패 item을 null로 유지(위치 정렬 보존) |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

- UNIQUE 제약: `scheduler_stages_scheduler_id_stage_order_key UNIQUE(scheduler_id, stage_order) DEFERRABLE INITIALLY DEFERRED` (005에서 non-deferrable 버전을 drop 후 재생성 — 원자적 reorder를 위함)

### 3.6 `scheduler_runs`

Scheduler 실행 이력. top-level status는 update-in-place.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `scheduler_id` | `UUID` | NOT NULL | | FK → `schedulers.id` `ON DELETE CASCADE` |
| `status` | `scheduler_run_status` | NOT NULL | `'pending'` | |
| `started_at` | `TIMESTAMPTZ` | NULL | | |
| `completed_at` | `TIMESTAMPTZ` | NULL | | |
| `result` | `JSONB` | NULL | | 마지막 stage의 output |
| `error` | `TEXT` | NULL | | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

- CHECK: `completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at`
- Index: `scheduler_runs_scheduler_id_index ON scheduler_runs(scheduler_id)`
- **Partial unique index (006)**: `scheduler_runs_one_active_per_scheduler ON scheduler_runs (scheduler_id) WHERE status IN ('pending', 'running')`
  - scheduler당 active run(pending/running) 1개만 허용. 동시 실행 방지의 원자적 guard.
  - 006 migration은 index 생성 전에 기존 중복 active run을 정리(가장 최근 것만 유지, 나머지는 `status='failed'`, `error='Cleaned up by migration 006'`)하는 데이터 UPDATE를 포함.

### 3.7 `scheduler_stage_runs`

Run 내 stage별 실행 기록 (디버깅/UI용).

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `run_id` | `UUID` | NOT NULL | | FK → `scheduler_runs.id` `ON DELETE CASCADE` |
| `stage_id` | `UUID` | NOT NULL | | FK → `scheduler_stages.id` `ON DELETE CASCADE` |
| `stage_order` | `INTEGER` | NOT NULL | | `CHECK (stage_order >= 0)` |
| `status` | `scheduler_run_status` | NOT NULL | `'pending'` | |
| `started_at` | `TIMESTAMPTZ` | NULL | | |
| `completed_at` | `TIMESTAMPTZ` | NULL | | |
| `input` | `JSONB` | NULL | | |
| `output` | `JSONB` | NULL | | |
| `error` | `TEXT` | NULL | | |
| `items_total` | `INTEGER` | NULL | | fan-out: 총 item 수. `CHECK (items_total >= 0)` |
| `items_succeeded` | `INTEGER` | NULL | | `CHECK (items_succeeded >= 0)` |
| `items_failed` | `INTEGER` | NULL | | `CHECK (items_failed >= 0)` |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

- CHECK: `completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at`
- CHECK: `items_total IS NULL OR items_succeeded IS NULL OR items_failed IS NULL OR items_succeeded + items_failed <= items_total`
- Index: `scheduler_stage_runs_run_id_index ON scheduler_stage_runs(run_id)`

### 3.8 `crawler_permissions`

Crawler 사용 권한 (marketplace 구독 확장 대비). 007에서 생성 + 기존 crawler 생성자에게 `owner` backfill.

| 컬럼 | 타입 | Nullable | Default | 비고 |
|------|------|----------|---------|------|
| `id` | `UUID` | NOT NULL | `gen_random_uuid()` | **PK** |
| `crawler_id` | `UUID` | NOT NULL | | FK → `crawlers.id` `ON DELETE CASCADE` |
| `user_uuid` | `UUID` | NOT NULL | | FK → `users.uuid` `ON DELETE CASCADE` |
| `level` | `crawler_permission_level` | NOT NULL | | `owner` = 생성자(전체 제어), `subscriber` = stage에서 사용 가능 |
| `created_at` | `TIMESTAMPTZ` | NOT NULL | `NOW()` | |

- UNIQUE: `(crawler_id, user_uuid)`
- Index: `crawler_permissions_user_uuid_index ON crawler_permissions(user_uuid)`, `crawler_permissions_crawler_id_index ON crawler_permissions(crawler_id)`

### 관계 요약 (ERD)

```
users (uuid PK)
  ├─< accounts (provider, identifier PK; uuid FK, CASCADE)
  ├─< crawlers (user_uuid FK, CASCADE)
  ├─< schedulers (user_uuid FK, CASCADE)
  └─< crawler_permissions (user_uuid FK, CASCADE)

crawlers (id PK)
  ├─< scheduler_stages (crawler_id FK, RESTRICT)   ← 사용 중 crawler 삭제 차단
  └─< crawler_permissions (crawler_id FK, CASCADE)

schedulers (id PK)
  ├─< scheduler_stages (scheduler_id FK, CASCADE)  UNIQUE(scheduler_id, stage_order) DEFERRABLE
  └─< scheduler_runs (scheduler_id FK, CASCADE)    partial unique: 1 active run per scheduler

scheduler_runs (id PK)
  └─< scheduler_stage_runs (run_id FK, CASCADE)

scheduler_stages (id PK)
  └─< scheduler_stage_runs (stage_id FK, CASCADE)
```

---

## 4. DB Functions / RPC / Triggers

| 이름 | 종류 | 정의 | 용도 |
|------|------|------|------|
| `update_crawlers_updated_at()` | trigger function (plpgsql) | 002 | `crawlers.updated_at = NOW()` |
| `update_schedulers_updated_at()` | trigger function (plpgsql) | 004 | `schedulers.updated_at = NOW()` |
| `reorder_scheduler_stages(p_scheduler_id UUID, p_stage_ids UUID[]) RETURNS SETOF scheduler_stages` | **RPC** (PostgREST 노출) | 005 | stage_order를 배열 순서대로 0,1,2,... 재할당. DEFERRABLE 제약 덕에 트랜잭션 커밋 시점에만 unique 검사. 검증: 빈 배열 거부, 제공된 distinct ID 수 = 해당 scheduler의 stage 수 아니면 EXCEPTION. 반환: stage_order 순 정렬된 전체 stage |

## 5. RLS

**Migration에 RLS 정의 없음** (`ENABLE ROW LEVEL SECURITY`, `CREATE POLICY` 전무).
접근 제어는 전적으로 application layer에서 수행:

- `createSupabaseClient()`는 **secret key**(service role)로 생성 → RLS bypass. 서버 환경(Workers) 전용 (`packages/supabase-connector/sources/client.ts` 주석에 명시).
- 사용자 격리는 모든 쿼리에 `user_uuid` / `scheduler_id` 조건을 붙이는 방식으로 구현 (아래 §7, §8).
- 브라우저(applications/web)는 DB에 직접 접근하지 않음 — worker HTTP API 경유. connector에서 **type import만** 사용.

---

## 6. TypeScript 계약 (`packages/supabase-connector/sources/types/database.ts`)

Supabase client의 `Database` generic 타입. 재작성 시 이 shape 유지 필요 (모든 Row 타입에 `[key: string]: unknown` index signature 존재).

```typescript
export type ProviderType = OAuthProviderID;   // from '@audio-underview/sign-provider'
export type CrawlerType = 'web' | 'data';
export type SchedulerRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'partially_failed';
export type CrawlerPermissionLevel = 'owner' | 'subscriber';
export type FanOutStrategy = 'compact' | 'preserve';

export interface UserRow { [key: string]: unknown; uuid: string; }
// 주의: users.created_at은 DB에는 있지만 UserRow 타입에는 명시되지 않음 (index signature로 커버)

export interface AccountRow {
  [key: string]: unknown;
  provider: ProviderType; identifier: string; uuid: string;
}

export interface CrawlerRow {
  [key: string]: unknown;
  id: string; user_uuid: string; name: string; type: CrawlerType;
  url_pattern: string | null; code: string;
  input_schema: Record<string, unknown>; output_schema: Record<string, unknown>;
  created_at: string; updated_at: string;
}

export interface SchedulerRow {
  [key: string]: unknown;
  id: string; user_uuid: string; name: string;
  cron_expression: string | null; is_enabled: boolean; last_run_at: string | null;
  created_at: string; updated_at: string;
}

export interface SchedulerStageRow {
  [key: string]: unknown;
  id: string; scheduler_id: string; crawler_id: string; stage_order: number;
  input_schema: Record<string, unknown>; output_schema: Record<string, unknown>;
  fan_out_field: string | null; fan_out_strategy: FanOutStrategy;
  created_at: string;
}

export interface SchedulerRunRow {
  [key: string]: unknown;
  id: string; scheduler_id: string; status: SchedulerRunStatus;
  started_at: string | null; completed_at: string | null;
  result: unknown; error: string | null; created_at: string;
}

export interface SchedulerStageRunRow {
  [key: string]: unknown;
  id: string; run_id: string; stage_id: string; stage_order: number;
  status: SchedulerRunStatus;
  started_at: string | null; completed_at: string | null;
  input: unknown; output: unknown; error: string | null;
  items_total: number | null; items_succeeded: number | null; items_failed: number | null;
  created_at: string;
}

export interface CrawlerPermissionRow {
  [key: string]: unknown;
  id: string; crawler_id: string; user_uuid: string;
  level: CrawlerPermissionLevel; created_at: string;
}

export interface SocialLoginInput { provider: ProviderType; identifier: string; }
export interface SocialLoginResult { userUUID: string; isNewUser: boolean; isNewAccount: boolean; }
export interface LinkAccountResult { success: boolean; alreadyLinked: boolean; }
export interface SupabaseConnectorConfiguration { supabaseURL: string; supabaseSecretKey: string; }
```

`Database['public']`:
- `Tables`: 위 8개 테이블. 각각 `Row` / `Insert` / `Update` / `Relationships`(FK 이름 포함: `accounts_uuid_fkey`, `crawlers_user_uuid_fkey`, `schedulers_user_uuid_fkey`, `scheduler_stages_scheduler_id_fkey`, `scheduler_stages_crawler_id_fkey`, `scheduler_runs_scheduler_id_fkey`, `scheduler_stage_runs_run_id_fkey`, `scheduler_stage_runs_stage_id_fkey`, `crawler_permissions_crawler_id_fkey`, `crawler_permissions_user_uuid_fkey`)
- `Insert` 필수 필드:
  - `accounts`: `provider`, `identifier`, `uuid`
  - `crawlers`: `user_uuid`, `name`, `code` (나머지 optional)
  - `schedulers`: `user_uuid`, `name`
  - `scheduler_stages`: `scheduler_id`, `crawler_id`, `stage_order`, `input_schema`
  - `scheduler_runs`: `scheduler_id`
  - `scheduler_stage_runs`: `run_id`, `stage_id`, `stage_order`
  - `crawler_permissions`: `crawler_id`, `user_uuid`, `level`
- `Update` 제외 필드 (immutable 취급):
  - `crawlers`: `created_at`, `updated_at` 제외
  - `schedulers`: `created_at`, `updated_at` 제외
  - `scheduler_stages`: `id`, `scheduler_id`, `created_at` 제외
  - `scheduler_runs`: `id`, `scheduler_id`, `created_at` 제외
  - `scheduler_stage_runs`: `id`, `run_id`, `stage_id`, `created_at` 제외
  - `crawler_permissions`: `id`, `created_at` 제외
- `Functions`: `reorder_scheduler_stages: { Args: { p_scheduler_id: string; p_stage_ids: string[] }; Returns: SchedulerStageRow[] }`
- `Enums`: `provider_type`, `crawler_type`, `scheduler_run_status`, `crawler_permission_level` (주: `fan_out_strategy`는 Enums 항목에 누락 — 타입으로만 존재)
- Insert type alias: `UsersInsert`, `AccountsInsert`, `CrawlersInsert`, `CrawlersUpdate`, `SchedulersInsert`, `SchedulersUpdate`, `SchedulerStagesInsert`, `SchedulerStagesUpdate`, `SchedulerRunsInsert`, `SchedulerRunsUpdate`, `SchedulerStageRunsInsert`, `SchedulerStageRunsUpdate`

---

## 7. Connector API (`packages/supabase-connector/sources/`)

모든 함수는 `traceDatabaseOperation({ serviceName: 'supabase-connector', operation, table }, ...)` (axiom-logger)로 wrapping. 에러 시 `Failed to <verb> <entity>: ${error.message}` 형태의 Error throw. 단건 조회(get/find)는 not-found 시 `undefined` 반환.

### client.ts
- `createSupabaseClient({ supabaseURL, supabaseSecretKey })` → `SupabaseClient<Database>`
  - options: `{ auth: { autoRefreshToken: false, persistSession: false } }`

### accounts.ts (tables: `users`, `accounts`)
| 함수 | Operation |
|------|-----------|
| `findAccount(client, { provider, identifier })` | `accounts` SELECT * WHERE provider= AND identifier= `.single()` |
| `findUser(client, userUUID)` | `users` SELECT * WHERE uuid= `.single()` |
| `getAccountsByUser(client, userUUID)` | `accounts` SELECT * WHERE uuid= |
| `createUser(client)` | `users` INSERT {} RETURNING * |
| `createAccount(client, { provider, identifier, userUUID })` | `accounts` INSERT RETURNING * |
| `handleSocialLogin(client, input)` | findAccount → 있으면 기존 userUUID 반환. 없으면 createUser + createAccount. **account 생성 실패 시 deleteUser로 rollback** (rollback도 실패하면 orphaned user UUID 포함 에러 throw). 반환: `{ userUUID, isNewUser, isNewAccount }` |
| `linkAccount(client, userUUID, input)` | findAccount → 이미 같은 user에 연결이면 `{ success: true, alreadyLinked: true }`. 다른 user에 연결이면 throw. 미연결이면 findUser 검증 후 createAccount |
| `unlinkAccount(client, userUUID, input)` | `accounts` DELETE WHERE provider= AND identifier= AND uuid= RETURNING → boolean |
| `deleteUser(client, userUUID)` | `users` DELETE WHERE uuid= RETURNING → boolean (CASCADE로 accounts/crawlers/schedulers/permissions 연쇄 삭제) |

### crawlers.ts (table: `crawlers`)
| 함수 | Operation |
|------|-----------|
| `createCrawler(client, input: CrawlersInsert)` | INSERT RETURNING * |
| `listCrawlersByUser(client, userUUID, { offset?, limit? })` | SELECT *, count 'exact' WHERE user_uuid= ORDER BY created_at DESC RANGE(offset, offset+limit-1). **기본값 offset=0(min 0), limit=20(min 1)**. 반환 `{ data, total }` |
| `getCrawlerByID(client, id)` | SELECT * WHERE id= `.single()` — **user 필터 없음** (내부 실행용) |
| `getCrawler(client, id, userUUID)` | SELECT * WHERE id= AND user_uuid= `.single()` |
| `updateCrawler(client, id, userUUID, input: CrawlersUpdate)` | UPDATE WHERE id= AND user_uuid= RETURNING `.single()` |
| `deleteCrawler(client, id, userUUID)` | DELETE WHERE id= AND user_uuid= RETURNING → boolean. scheduler_stages FK RESTRICT에 걸리면 DB 에러 |

### crawler-permissions.ts (table: `crawler_permissions`)
| 함수 | Operation |
|------|-----------|
| `createCrawlerPermission(client, { crawler_id, user_uuid, level })` | INSERT RETURNING `.single()` |
| `getCrawlerPermission(client, crawlerID, userUUID)` | SELECT WHERE crawler_id= AND user_uuid= `.maybeSingle()` |
| `deleteCrawlerPermission(client, crawlerID, userUUID)` | DELETE WHERE crawler_id= AND user_uuid= |

### schedulers.ts (table: `schedulers`)
| 함수 | Operation |
|------|-----------|
| `createScheduler(client, input: SchedulersInsert)` | INSERT RETURNING `.single()` |
| `listSchedulersByUser(client, userUUID, { offset?, limit? })` | SELECT *, count 'exact' WHERE user_uuid= ORDER BY created_at DESC + range 페이지네이션 (crawlers와 동일 패턴). 반환 `{ data, total }` |
| `getScheduler(client, id, userUUID)` | SELECT * WHERE id= AND user_uuid= `.single()` |
| `updateScheduler(client, id, userUUID, input: SchedulersUpdate)` | UPDATE WHERE id= AND user_uuid= RETURNING `.single()` |
| `deleteScheduler(client, id, userUUID)` | DELETE WHERE id= AND user_uuid= RETURNING → boolean |

### scheduler-stages.ts (table: `scheduler_stages`)
| 함수 | Operation |
|------|-----------|
| `createSchedulerStage(client, input: SchedulerStagesInsert)` | INSERT RETURNING `.single()` |
| `listSchedulerStages(client, schedulerID)` | SELECT * WHERE scheduler_id= ORDER BY stage_order ASC |
| `getSchedulerStage(client, id, schedulerID)` | SELECT * WHERE id= AND scheduler_id= `.single()` |
| `updateSchedulerStage(client, id, schedulerID, input)` | UPDATE WHERE id= AND scheduler_id= RETURNING `.single()` |
| `deleteSchedulerStage(client, id, schedulerID)` | DELETE WHERE id= AND scheduler_id= RETURNING → boolean |
| `reorderSchedulerStages(client, schedulerID, stageIDs)` | **RPC** `reorder_scheduler_stages(p_scheduler_id, p_stage_ids)` → `SchedulerStageRow[]` |

### scheduler-runs.ts (table: `scheduler_runs`)
| 함수 | Operation |
|------|-----------|
| `createSchedulerRun(client, input: SchedulerRunsInsert)` | INSERT RETURNING `.single()`. active-run partial unique index 위반 가능 |
| `getSchedulerRun(client, id, schedulerID)` | SELECT * WHERE id= AND scheduler_id= `.single()` |
| `updateSchedulerRun(client, id, schedulerID, input, { onlyIfStatus? })` | UPDATE WHERE id= AND scheduler_id= [+ `IN ('status', onlyIfStatus)` — **조건부 상태 전이 guard**] RETURNING `.single()` |
| `listSchedulerRuns(client, schedulerID, { offset?, limit? })` | SELECT *, count 'exact' WHERE scheduler_id= ORDER BY created_at DESC + range 페이지네이션. 반환 `{ data, total }` |

### scheduler-stage-runs.ts (table: `scheduler_stage_runs`)
| 함수 | Operation |
|------|-----------|
| `createSchedulerStageRun(client, input: SchedulerStageRunsInsert)` | INSERT RETURNING `.single()` |
| `updateSchedulerStageRun(client, id, runID, input)` | UPDATE WHERE id= AND run_id= RETURNING `.single()` |
| `listSchedulerStageRunsByRun(client, runID)` | SELECT * WHERE run_id= ORDER BY stage_order ASC |

---

## 8. Worker별 DB 접근 (query 목록)

DB 접근 환경변수: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (각 worker의 `Environment`).
브라우저 앱(applications/web)은 DB 직접 접근 없음 — connector에서 type만 import.

### 8.1 `workers/crawler-manager-worker/`

| 엔드포인트/경로 | DB operations |
|------------------|---------------|
| `POST /crawlers` | ① `crawlers` INSERT `{ user_uuid, name, type, url_pattern (type='data'이면 null), code, input_schema, output_schema }` ② `crawler_permissions` INSERT `{ crawler_id, user_uuid, level: 'owner' }` — **비트랜잭션 2단계** |
| `GET /crawlers` | `crawlers` SELECT paginated WHERE user_uuid= (offset/limit query param, 기본 limit 20) |
| `GET /crawlers/:id` | `crawlers` SELECT WHERE id= AND user_uuid= |
| `PUT /crawlers/:id` | `crawlers` UPDATE `{ name, type, url_pattern (type='data'이면 null), code, input_schema, output_schema }` WHERE id= AND user_uuid= → 없으면 404 |
| `DELETE /crawlers/:id` | `crawlers` DELETE WHERE id= AND user_uuid= → 없으면 404 (scheduler_stages FK RESTRICT 시 에러) |
| `POST /authentication/token` | `accounts` SELECT WHERE provider= AND identifier= (`findAccount`) → 없으면 401. 있으면 JWT 발급 (`sub` = `account.uuid`) |
| RPC `executeCrawler(crawlerID, input)` (service binding, scheduler-manager에서 호출) | `crawlers` SELECT WHERE id= (`getCrawlerByID`, **user 필터 없음**) → code-runner로 실행 |

### 8.2 `workers/scheduler-manager-worker/`

**handlers/schedulers.ts** (`/schedulers` CRUD):
- `POST /schedulers` → `schedulers` INSERT (user_uuid, name, cron_expression?, is_enabled?)
- `GET /schedulers` → `schedulers` SELECT paginated WHERE user_uuid=
- `GET /schedulers/:id` → SELECT WHERE id= AND user_uuid=
- `PUT/PATCH /schedulers/:id` → UPDATE WHERE id= AND user_uuid=
- `DELETE /schedulers/:id` → DELETE WHERE id= AND user_uuid=

**handlers/scheduler-stages.ts** (`/schedulers/:id/stages`):
- create: ① `getScheduler`로 ownership 검증(handlers/tools.ts) ② `crawler_permissions` SELECT WHERE crawler_id= AND user_uuid= (`getCrawlerPermission`) — **permission row 없으면 stage 생성 거부** ③ `scheduler_stages` INSERT
- list: `scheduler_stages` SELECT WHERE scheduler_id= ORDER BY stage_order ASC
- get: SELECT WHERE id= AND scheduler_id=
- update: crawler_id 변경 시 permission 재검증 후 UPDATE WHERE id= AND scheduler_id=
- delete: DELETE WHERE id= AND scheduler_id=
- reorder: RPC `reorder_scheduler_stages(schedulerID, stage_ids)`

**handlers/scheduler-execution.ts** (`POST /schedulers/:id/execute`):
1. `getScheduler` ownership 검증
2. `scheduler_runs` INSERT `{ scheduler_id, status: 'pending' }` — **에러 메시지에 `scheduler_runs_one_active_per_scheduler` 포함 시 409 conflict 반환** (동시 실행 guard)
3. `executeScheduler` 실행, **5분 timeout** (`Promise.race` + AbortController)
4. timeout 시: `scheduler_runs` UPDATE `{ status: 'failed', completed_at, error }` **WHERE status IN ('pending','running')** (`onlyIfStatus` guard — executor와의 race 방지)
5. 최종 상태 `getSchedulerRun`으로 재조회 후 응답

**scheduler-executor.ts** (`executeScheduler`) — run 상태 머신:
1. `scheduler_runs` UPDATE `{ status: 'running', started_at: now }`
2. `scheduler_stages` SELECT WHERE scheduler_id= ORDER BY stage_order
3. stage 0개 → UPDATE `{ status: 'completed', completed_at, result: null }` 후 종료
4. 첫 stage input = `resolveDefaultInput(stages[0].input_schema)` (JSON Schema의 `default` 값 수집)
5. stage마다:
   - fan-out 아닌 경우 (`stage-runner.ts executeStage`): `scheduler_stage_runs` INSERT `{ run_id, stage_id, stage_order, status: 'running', started_at, input }` → crawler 실행 → 성공: UPDATE `{ status: 'completed', completed_at, output }` / 실패: UPDATE `{ status: 'failed', completed_at, error }` 후 throw
   - fan-out인 경우 (`fan_out_field` 지정): input object에서 해당 field의 배열 추출(없거나 비배열이면 throw) → stage_run INSERT (`status: 'running'`, input) → 빈 배열이면 UPDATE `{ status: 'completed', output: [], items_total: 0, items_succeeded: 0, items_failed: 0 }` → item별 실행 후 UPDATE `{ status (completed/partially_failed/failed), completed_at, output: results, items_total, items_succeeded, items_failed }` → 전부 실패면 throw, 일부 실패면 `hasPartialFailure = true`
   - stage output이 다음 stage input이 됨 (chaining)
6. 성공 종료: `scheduler_runs` UPDATE `{ status: hasPartialFailure ? 'partially_failed' : 'completed', completed_at, result: lastOutput }`
7. 에러: `scheduler_runs` UPDATE `{ status: 'failed', completed_at, error }`
8. `finally`: `schedulers` UPDATE `{ last_run_at: now }` WHERE id= AND user_uuid= (abort 시 skip)
- AbortSignal aborted 시 이후 DB update 전부 skip (timeout 경로가 대신 기록)

**handlers/scheduler-runs.ts** (`/schedulers/:id/runs`):
- list: `scheduler_runs` SELECT paginated WHERE scheduler_id= ORDER BY created_at DESC (사전 ownership 검증)
- get: SELECT WHERE id= AND scheduler_id=

**token-exchange.ts**: crawler-manager와 동일 — `accounts` SELECT (`findAccount`) → JWT 발급.

### 8.3 OAuth provider workers

- `workers/github-oauth-provider-worker/`, `workers/google-oauth-provider-worker/`: OAuth callback에서 `handleSocialLogin` 호출 → `accounts` SELECT / `users` INSERT / `accounts` INSERT (+ 실패 시 `users` DELETE rollback)
- 나머지 provider worker (apple, discord, facebook, kakao, microsoft)는 존재하지만 **connector 미사용** (DB 연동 미구현). `provider_type` enum은 10개 provider를 미리 포함 (x, linkedin, naver는 worker도 없음)

### 8.4 DB 미접근 worker
- `workers/crawler-code-runner-worker/`: DB 접근 없음 (코드 실행 전용)
- connector 외부에서 raw `.from('table')` 직접 사용처 없음 (axiom-logger의 주석 예시 1건 제외). 모든 DB 접근은 supabase-connector 경유.

---

## 9. 테스트 mock에서 확인되는 record shape

`packages/supabase-connector/sources/test-helpers.ts`의 `createMockClient`는 chain method `select/insert/update/delete/eq/range/order` + `single`을 mocking — connector가 사용하는 query surface의 전체 목록과 일치.

대표 mock 데이터 (worker 테스트):

```typescript
// workers/crawler-manager-worker/tests/crawler-executor.test.ts
const mockCrawler: CrawlerRow = {
  id: '00000000-0000-0000-0000-000000000001',
  user_uuid: '00000000-0000-0000-0000-000000000002',
  name: 'Test Crawler',
  type: 'web',
  url_pattern: '.*\\.example\\.com',
  code: '(text) => ({ title: "test" })',
  input_schema: { body: 'string' },
  output_schema: {},
  // + created_at, updated_at
};

// workers/scheduler-manager-worker/tests/scheduler-executor.test.ts
const mockStage: SchedulerStageRow = {
  id: STAGE_ID,
  scheduler_id: SCHEDULER_ID,
  crawler_id: CRAWLER_ID,
  stage_order: 0,
  input_schema: { url: { type: 'string', default: 'https://example.com' } },
  output_schema: {},
  fan_out_field: null,
  fan_out_strategy: 'compact',
  created_at: '2026-01-01T00:00:00Z',
};
```

주목: crawler의 `input_schema`는 `{ field: "type문자열" }` 축약형(`{ body: 'string' }`), stage의 `input_schema`는 JSON Schema 확장형(`{ field: { type, default } }`) — **두 계층이 서로 다른 schema 표기 규약**을 쓴다.

---

## 10. 특이사항 / 재작성 시 함정

1. **`url_pattern` nullability**: 001~002 시점엔 NOT NULL이었다가 003에서 NULL 허용. `type='data'`이면 애플리케이션이 항상 null로 강제.
2. **DEFERRABLE unique**: `scheduler_stages`의 `(scheduler_id, stage_order)` unique는 반드시 `DEFERRABLE INITIALLY DEFERRED` — reorder RPC가 이에 의존.
3. **Partial unique index 이름에 의존하는 코드**: scheduler-execution handler가 에러 메시지 문자열에서 `scheduler_runs_one_active_per_scheduler`를 검색해 409를 반환. 인덱스 이름 변경 시 코드가 깨짐.
4. **`onlyIfStatus` guard**: run 상태 전이는 timeout 경로에서 `WHERE status IN ('pending','running')` 조건부 UPDATE로 race를 방지. 상태 머신: `pending → running → (completed | partially_failed | failed)`.
5. **비트랜잭션 다단계 write**: (a) crawler 생성 + owner permission 부여, (b) handleSocialLogin의 user+account 생성(수동 rollback 구현). Postgres 트랜잭션이 아니라 애플리케이션 레벨 보상 로직.
6. **`crawler_id` FK RESTRICT**: stage가 참조 중인 crawler는 삭제 불가 — DELETE /crawlers/:id가 DB 에러로 실패할 수 있음.
7. **permission 모델**: stage 생성/crawler 변경 시 `crawler_permissions`에 (crawler_id, user_uuid) row 존재 여부만 검사 (level 무관 — owner든 subscriber든 사용 가능). crawler CRUD 자체는 permission 테이블이 아니라 `crawlers.user_uuid`로만 검사.
8. **RLS 없음**: 모든 테이블 RLS 미설정. secret key client 전제. 재작성에서 브라우저 직접 접근 도입 시 RLS 전면 신설 필요.
9. **`fan_out_strategy` enum이 TS `Database.Enums`에 누락** (기능 영향 없음, 타입 완전성 문제).
10. **timestamp는 TS에서 전부 ISO string** (`new Date().toISOString()`으로 기록).
11. **pagination 계약**: offset 기본 0, limit 기본 20 (최소 1), `count: 'exact'`, 정렬은 목록 성격에 따라 `created_at DESC`(crawlers/schedulers/runs) 또는 `stage_order ASC`(stages/stage_runs).

---

## 11. Migration 원문 SQL (전문)

### 001_create_users_and_accounts.sql

```sql
-- Migration: Create users and accounts tables for social login integration
-- Run this in Supabase SQL Editor or via migrations

-- Provider enum type
-- Includes all supported OAuth providers
CREATE TYPE provider_type AS ENUM (
  'google',
  'github',
  'apple',
  'microsoft',
  'facebook',
  'x',
  'linkedin',
  'discord',
  'kakao',
  'naver'
);

-- Users table (integrated accounts)
-- Each user can have multiple social login accounts
CREATE TABLE users (
  uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Accounts table (social login accounts)
-- Links social provider accounts to users
CREATE TABLE accounts (
  provider provider_type NOT NULL,
  identifier TEXT NOT NULL,
  uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, identifier)
);

-- Index for efficient user lookup
CREATE INDEX accounts_uuid_index ON accounts(uuid);

-- Comments for documentation
COMMENT ON TABLE users IS 'Integrated user accounts that can have multiple social login providers';
COMMENT ON TABLE accounts IS 'Social login accounts linked to users';
COMMENT ON COLUMN accounts.provider IS 'OAuth provider type (google, github, etc.)';
COMMENT ON COLUMN accounts.identifier IS 'Provider-specific unique identifier (sub for Google, id for GitHub, etc.)';
COMMENT ON COLUMN accounts.uuid IS 'Reference to the integrated user account';
```

### 002_create_crawlers.sql

```sql
-- Migration: Create crawlers table for storing user-defined crawlers

-- Crawlers table
-- Each crawler belongs to a user and contains code to process matched URLs
CREATE TABLE crawlers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url_pattern TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for efficient user lookup
CREATE INDEX crawlers_user_uuid_index ON crawlers(user_uuid);

-- Comments for documentation
COMMENT ON TABLE crawlers IS 'User-defined crawlers that process matched URLs';
COMMENT ON COLUMN crawlers.user_uuid IS 'Reference to the owning user account';
COMMENT ON COLUMN crawlers.name IS 'Human-readable name for the crawler';
COMMENT ON COLUMN crawlers.url_pattern IS 'Regex pattern to match URLs this crawler should process';
COMMENT ON COLUMN crawlers.code IS 'JavaScript code to execute against fetched page content';

-- Auto-refresh updated_at on row updates
CREATE OR REPLACE FUNCTION update_crawlers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crawlers_updated_at_trigger
  BEFORE UPDATE ON crawlers
  FOR EACH ROW
  EXECUTE FUNCTION update_crawlers_updated_at();
```

### 003_add_crawler_type_and_schemas.sql

```sql
-- Migration: Add type and schema columns to crawlers table
-- Supports two crawler types:
--   web: fetches URL then runs code(body) — input_schema defaults to { body: "string" }
--   data: runs code(data) directly — input_schema is user-defined, url_pattern is null

CREATE TYPE crawler_type AS ENUM ('web', 'data');

ALTER TABLE crawlers ADD COLUMN type crawler_type NOT NULL DEFAULT 'web';
ALTER TABLE crawlers ADD COLUMN input_schema JSONB NOT NULL DEFAULT '{"body": "string"}';
ALTER TABLE crawlers ADD COLUMN output_schema JSONB NOT NULL DEFAULT '{}';
ALTER TABLE crawlers ALTER COLUMN url_pattern DROP NOT NULL;

COMMENT ON COLUMN crawlers.type IS 'Crawler type: web (URL fetch + code) or data (code only)';
COMMENT ON COLUMN crawlers.input_schema IS 'Schema describing the input the crawler code expects';
COMMENT ON COLUMN crawlers.output_schema IS 'Schema describing the output the crawler code produces';
```

### 004_create_schedulers.sql

```sql
-- Migration: Create scheduler tables for pipeline orchestration
-- A scheduler chains multiple crawlers into stages and executes them sequentially

-- Schedulers table
CREATE TABLE schedulers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX schedulers_user_uuid_index ON schedulers(user_uuid);

COMMENT ON TABLE schedulers IS 'Pipeline definitions that chain crawlers into sequential stages';
COMMENT ON COLUMN schedulers.user_uuid IS 'Reference to the owning user account';
COMMENT ON COLUMN schedulers.name IS 'Human-readable name for the scheduler';
COMMENT ON COLUMN schedulers.cron_expression IS 'Optional cron schedule for automatic execution';
COMMENT ON COLUMN schedulers.is_enabled IS 'Whether automatic execution is enabled';
COMMENT ON COLUMN schedulers.last_run_at IS 'Timestamp of the most recent execution';

-- Auto-refresh updated_at on row updates
CREATE OR REPLACE FUNCTION update_schedulers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schedulers_updated_at_trigger
  BEFORE UPDATE ON schedulers
  FOR EACH ROW
  EXECUTE FUNCTION update_schedulers_updated_at();

-- Scheduler stages table
-- Each stage references a crawler and defines input/output schema for the pipeline
CREATE TABLE scheduler_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_id UUID NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE RESTRICT,
  stage_order INTEGER NOT NULL CHECK (stage_order >= 0),
  input_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL DEFAULT '{}',
  fan_out_field TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(scheduler_id, stage_order)
);

COMMENT ON TABLE scheduler_stages IS 'Stages within a scheduler pipeline, each referencing a crawler';
COMMENT ON COLUMN scheduler_stages.crawler_id IS 'Reference to the crawler to execute (RESTRICT prevents deleting in-use crawlers)';
COMMENT ON COLUMN scheduler_stages.stage_order IS 'Execution order within the pipeline (0-based)';
COMMENT ON COLUMN scheduler_stages.input_schema IS 'JSON Schema defining stage input with optional defaults (e.g. { url: { type: "string", default: "https://..." } })';
COMMENT ON COLUMN scheduler_stages.output_schema IS 'JSON Schema defining stage output, derived from crawler output_schema';
COMMENT ON COLUMN scheduler_stages.fan_out_field IS 'Field name in previous stage output to fan-out over (null if no fan-out)';

-- Run status enum
CREATE TYPE scheduler_run_status AS ENUM (
  'pending', 'running', 'completed', 'failed', 'partially_failed'
);

-- Scheduler runs table
-- Tracks execution history for each scheduler (update-in-place for top-level status)
CREATE TABLE scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduler_id UUID NOT NULL REFERENCES schedulers(id) ON DELETE CASCADE,
  status scheduler_run_status NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
);

CREATE INDEX scheduler_runs_scheduler_id_index ON scheduler_runs(scheduler_id);

COMMENT ON TABLE scheduler_runs IS 'Execution history for scheduler pipelines';
COMMENT ON COLUMN scheduler_runs.status IS 'Run status: pending, running, completed, failed, partially_failed';

-- Scheduler stage runs table
-- Per-stage execution records for debugging and UI display
CREATE TABLE scheduler_stage_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  stage_id UUID NOT NULL REFERENCES scheduler_stages(id) ON DELETE CASCADE,
  stage_order INTEGER NOT NULL CHECK (stage_order >= 0),
  status scheduler_run_status NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input JSONB,
  output JSONB,
  error TEXT,
  items_total INTEGER CHECK (items_total >= 0),
  items_succeeded INTEGER CHECK (items_succeeded >= 0),
  items_failed INTEGER CHECK (items_failed >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK (items_total IS NULL OR items_succeeded IS NULL OR items_failed IS NULL OR items_succeeded + items_failed <= items_total)
);

CREATE INDEX scheduler_stage_runs_run_id_index ON scheduler_stage_runs(run_id);

COMMENT ON TABLE scheduler_stage_runs IS 'Per-stage execution records within a scheduler run';
COMMENT ON COLUMN scheduler_stage_runs.items_total IS 'Fan-out: total items processed';
COMMENT ON COLUMN scheduler_stage_runs.items_succeeded IS 'Fan-out: items that completed successfully';
COMMENT ON COLUMN scheduler_stage_runs.items_failed IS 'Fan-out: items that failed';
```

### 005_add_reorder_scheduler_stages.sql

```sql
-- Migration: Add DEFERRABLE constraint and reorder RPC for scheduler stages
-- Enables atomic reordering of stages without unique constraint violations

-- Replace UNIQUE constraint with DEFERRABLE version
-- This allows temporary duplicate (scheduler_id, stage_order) values within a transaction
ALTER TABLE scheduler_stages
  DROP CONSTRAINT scheduler_stages_scheduler_id_stage_order_key;

ALTER TABLE scheduler_stages
  ADD CONSTRAINT scheduler_stages_scheduler_id_stage_order_key
  UNIQUE(scheduler_id, stage_order) DEFERRABLE INITIALLY DEFERRED;

-- RPC function to atomically reorder stages
-- Accepts an ordered array of stage IDs and reassigns stage_order 0, 1, 2, ...
-- PostgREST wraps RPC calls in a transaction, so DEFERRABLE constraint
-- only checks uniqueness at commit time
CREATE OR REPLACE FUNCTION reorder_scheduler_stages(
  p_scheduler_id UUID,
  p_stage_ids UUID[]
) RETURNS SETOF scheduler_stages AS $$
DECLARE
  i INTEGER;
  provided_stage_count INTEGER;
  existing_stage_count INTEGER;
BEGIN
  -- Validate that the provided stage identifier array is not empty
  IF COALESCE(array_length(p_stage_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'stage_ids must not be empty';
  END IF;

  -- Count distinct identifiers supplied by the caller
  SELECT COUNT(DISTINCT stage_id)
  INTO provided_stage_count
  FROM unnest(p_stage_ids) AS stage_id;

  -- Count stages that currently belong to this scheduler
  SELECT COUNT(*)
  INTO existing_stage_count
  FROM scheduler_stages
  WHERE scheduler_id = p_scheduler_id;

  -- Validate that the supplied identifiers exactly match the scheduler's stages
  IF provided_stage_count <> existing_stage_count THEN
    RAISE EXCEPTION
      'stage_ids length (%) does not match the number of stages for scheduler % (%)',
      provided_stage_count, p_scheduler_id, existing_stage_count;
  END IF;

  FOR i IN 1..COALESCE(array_length(p_stage_ids, 1), 0) LOOP
    UPDATE scheduler_stages
    SET stage_order = i - 1
    WHERE id = p_stage_ids[i]
      AND scheduler_id = p_scheduler_id;
  END LOOP;

  RETURN QUERY
    SELECT * FROM scheduler_stages
    WHERE scheduler_id = p_scheduler_id
    ORDER BY stage_order;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reorder_scheduler_stages IS 'Atomically reorder stages within a scheduler pipeline. Accepts ordered array of stage IDs.';
```

### 006_add_active_run_unique_constraint.sql

```sql
-- Migration: Prevent concurrent runs for the same scheduler
-- Only one run with status 'pending' or 'running' can exist per scheduler at a time.
-- When a run completes (completed/failed/partially_failed), the index no longer blocks new runs.

-- Clean up duplicate active runs before creating the unique index.
-- Keeps the most recent active run per scheduler, marks others as failed.
UPDATE scheduler_runs
SET status = 'failed', error = 'Cleaned up by migration 006', completed_at = NOW()
WHERE id NOT IN (
  SELECT DISTINCT ON (scheduler_id) id
  FROM scheduler_runs
  WHERE status IN ('pending', 'running')
  ORDER BY scheduler_id, created_at DESC
)
AND status IN ('pending', 'running');

CREATE UNIQUE INDEX scheduler_runs_one_active_per_scheduler
  ON scheduler_runs (scheduler_id)
  WHERE status IN ('pending', 'running');
```

### 007_create_crawler_permissions.sql

```sql
-- Migration: Crawler permission system
-- Controls who can use a crawler in their scheduler stages.
-- Extensible for marketplace subscriptions.

CREATE TYPE crawler_permission_level AS ENUM ('owner', 'subscriber');

CREATE TABLE crawler_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  level crawler_permission_level NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(crawler_id, user_uuid)
);

CREATE INDEX crawler_permissions_user_uuid_index ON crawler_permissions(user_uuid);
CREATE INDEX crawler_permissions_crawler_id_index ON crawler_permissions(crawler_id);

COMMENT ON TABLE crawler_permissions IS 'Controls access to crawlers. Owner = creator, subscriber = marketplace user.';
COMMENT ON COLUMN crawler_permissions.level IS 'Permission level: owner (full control), subscriber (can use in stages)';

-- Backfill: grant owner permission to existing crawler creators
INSERT INTO crawler_permissions (crawler_id, user_uuid, level)
SELECT id, user_uuid, 'owner'
FROM crawlers
ON CONFLICT (crawler_id, user_uuid) DO NOTHING;
```

### 008_add_fan_out_strategy.sql

```sql
-- Add fan_out_strategy column to scheduler_stages
-- 'compact' (default): remove failed items from results
-- 'preserve': keep failed items as null, preserving positional alignment

CREATE TYPE fan_out_strategy AS ENUM ('compact', 'preserve');

ALTER TABLE scheduler_stages
  ADD COLUMN fan_out_strategy fan_out_strategy NOT NULL DEFAULT 'compact';
```
