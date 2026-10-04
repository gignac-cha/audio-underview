# 작업 그룹 설계

작성일 2026-10-04. 이 설계대로 `feature/task-groups` 브랜치에 구현했다. 요구사항은 `documents/migration/06-task-groups.md`에 있다.

지금 스케줄의 단계는 크롤러 하나를 실행한다. 이 문서는 단계에 작업 그룹도 놓을 수 있게 하는 방법을 정한다. 작업 그룹은 플랫폼이 미리 만들어 둔 작업 묶음이고, 하는 일은 스케줄러 밖의 워커가 구현한다. 이번에는 토대만 만든다. 실제 그룹은 없다.

기준 코드는 `main`(`223a861`)이다. 고치는 곳은 `packages/supabase-connector`, `workers/scheduler-manager-worker`, `applications/web` 세 곳이다. 새 의존성은 없다.

## 1. 전체 흐름

1. 그룹은 `task_groups` 테이블의 행으로 등록된다. 행 하나가 그룹의 버전 하나다.
2. 사용자는 단계를 만들 때 그룹과 버전을 고르고 설정을 채운다. 스케줄러는 저장할 때 설정을 그 버전의 설정 형식으로 검증한다.
3. 실행이 그룹 단계에 오면 스케줄러는 앞 단계의 출력을 입력 형식으로 검증하고, 그룹의 워커에 시작을 요청한 뒤 기다린다.
4. 그룹의 워커는 진행 상황을 알리고, 끝나면 출력 또는 실패를 알린다. 스케줄러는 그 알림을 기록하고 다음 단계로 넘어간다.
5. 60분 안에 알림이 없으면 스케줄러가 그 단계를 실패로 기록한다.

그룹 단계가 있는 실행은 예약이든 수동이든 Cloudflare Workflow 인스턴스가 맡는다. 크롤러 단계만 있는 스케줄의 수동 실행은 지금처럼 요청 안에서 실행한다.

## 2. 결정한 것과 이유

**그룹 목록은 DB 테이블에 둔다.** 스케줄러는 그룹의 id, 버전, 세 형식만 알면 된다. 이 정보를 코드가 아니라 데이터로 두면 그룹이 늘어도 스케줄러 코드는 그대로다. 단계가 `(그룹 id, 버전)`을 외래 키로 가리키므로 등록되지 않은 그룹이나 버전은 DB도 막는다. 등록된 행이 없으면 그룹 단계를 만들 수 없고, 스케줄러는 지금과 같이 동작한다.

**등록된 버전의 형식은 바꾸지 못한다.** 형식을 바꾸려면 새 버전을 등록한다. 이미 저장된 단계는 저장된 버전으로 실행되고, 저장할 때 검증한 설정은 계속 그 형식에 맞는다. trigger가 형식 변경을 막는다.

**실행을 시작할 때의 그룹과 버전을 단계 실행 기록에 적는다.** 그룹이 일하는 동안 사용자가 단계의 버전을 바꾸거나 단계를 지울 수 있다. 출력은 시작할 때의 버전으로 검증해야 하므로, 알림을 받을 때 단계를 다시 읽지 않고 단계 실행 기록에 적힌 값을 쓴다.

**그룹의 워커는 service binding으로 부른다.** 등록 행에 binding 이름(`worker_binding`)을 적고, 스케줄러는 실행할 때 환경에서 그 이름의 binding을 찾는다. 크롤러 호출(`CRAWLER_MANAGER`)과 같은 방식이고, 공개 주소나 인증 토큰이 필요 없다. 그룹을 붙일 때는 행을 등록하고 스케줄러의 `wrangler.toml`에 binding을 한 줄 더한다(10절).

**완료는 Workflow 이벤트로 기다린다.** 그룹 단계는 몇십 분이 걸릴 수 있어 요청 하나나 step 하나 안에서 기다릴 수 없다. 스케줄러는 시작만 요청하고 `step.waitForEvent`로 기다린다. 그룹의 워커가 완료를 알리면 스케줄러가 결과를 DB에 기록하고 그 인스턴스에 이벤트를 보낸다. 기다리는 동안 인스턴스는 `waiting` 상태다.

**결과의 기준은 DB다.** 이벤트는 깨우는 신호일 뿐이다. 깨어난 뒤나 제한 시간이 지난 뒤에 스케줄러는 단계 실행 기록을 읽어 결과를 정한다. 이벤트가 사라져도 결과가 틀리지 않고, 제한 시간에 다시 확인하게 된다.

**이벤트 종류는 단계 실행마다 다르다.** 종류에 단계 실행 기록의 ID를 넣는다. 같은 알림을 두 번 보내도, 늦게 도착해도 다른 단계의 대기를 깨우지 않는다.

**제한 시간은 모든 그룹이 60분이다.** 요구사항은 그룹이 "몇 분에서 몇십 분" 걸린다고 한다. 그룹마다 다른 값이 필요해지면 그때 등록 정보에 더한다.

**형식은 JSON Schema의 일부로 쓰고, 검증은 직접 구현한다.** 05에서 cron 해석을 직접 구현한 것과 같은 판단이다. 필요한 것은 객체·배열·기본 타입 검사 정도이고, 지원하는 키워드를 4절에 못 박는다.

**그룹 단계가 있는 수동 실행도 같은 Workflow가 맡는다.** 요청은 실행 기록과 인스턴스를 만들고 바로 응답한다. 예약 실행과 수동 실행이 같은 코드로 단계를 실행한다.

**코드에서 "설정"은 `settings`다.** 저장소 규칙은 `config`를 쓰지 않는다. `options`는 step 설정 같은 내부 값에 이미 쓰고 있어, 사용자가 채우는 값은 `settings`로 구분한다.

## 3. 데이터

마이그레이션 `packages/supabase-connector/migrations/012_add_task_groups.sql`:

```sql
-- Migration: Task groups
-- A scheduler stage runs either a crawler or a task group: a set of tasks the
-- platform prepared in advance, implemented by a worker outside the scheduler.
-- This adds the registry of task groups, the stage columns that point at one,
-- and what a stage run records about the group it runs.

-- One row per registered version of a task group. A registered version never
-- changes its schemas: a group that changes them registers a new version, and
-- a stage saved with an older version keeps running that version.
CREATE TABLE task_groups (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  input_schema JSONB NOT NULL,
  settings_schema JSONB NOT NULL,
  output_schema JSONB NOT NULL,
  worker_binding TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version),
  CONSTRAINT task_groups_id_check CHECK (id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND char_length(id) <= 63),
  CONSTRAINT task_groups_version_check CHECK (version >= 1),
  CONSTRAINT task_groups_worker_binding_check CHECK (worker_binding ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  CONSTRAINT task_groups_schemas_check CHECK (
    jsonb_typeof(input_schema) = 'object'
    AND jsonb_typeof(settings_schema) = 'object'
    AND jsonb_typeof(output_schema) = 'object'
  )
);

COMMENT ON TABLE task_groups IS 'Registered task groups, one row per version';
COMMENT ON COLUMN task_groups.input_schema IS 'JSON Schema the previous stage output must match';
COMMENT ON COLUMN task_groups.settings_schema IS 'JSON Schema the settings of a stage must match';
COMMENT ON COLUMN task_groups.output_schema IS 'JSON Schema the output of the group matches';
COMMENT ON COLUMN task_groups.worker_binding IS 'Name of the service binding of the scheduler worker that reaches the worker implementing the group';

-- Only the workers (service role) use this table.
ALTER TABLE task_groups ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION prevent_task_group_schema_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.input_schema IS DISTINCT FROM OLD.input_schema
    OR NEW.settings_schema IS DISTINCT FROM OLD.settings_schema
    OR NEW.output_schema IS DISTINCT FROM OLD.output_schema THEN
    RAISE EXCEPTION 'A registered task group version cannot change; register a new version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_groups_schema_change_trigger
  BEFORE UPDATE ON task_groups
  FOR EACH ROW
  EXECUTE FUNCTION prevent_task_group_schema_change();

-- A stage is a crawler stage or a task group stage. Existing stages are
-- crawler stages. A task group stage has no crawler, no fan-out and no schemas
-- of its own: its formats are those of the task group version it points at.
ALTER TABLE scheduler_stages
  ADD COLUMN stage_type TEXT NOT NULL DEFAULT 'crawler',
  ADD COLUMN task_group_id TEXT,
  ADD COLUMN task_group_version INTEGER,
  ADD COLUMN settings JSONB,
  ALTER COLUMN crawler_id DROP NOT NULL,
  ADD CONSTRAINT scheduler_stages_task_group_fkey
    FOREIGN KEY (task_group_id, task_group_version)
    REFERENCES task_groups (id, version) ON DELETE RESTRICT,
  ADD CONSTRAINT scheduler_stages_type_check CHECK (
    (
      stage_type = 'crawler'
      AND crawler_id IS NOT NULL
      AND task_group_id IS NULL
      AND task_group_version IS NULL
      AND settings IS NULL
    ) OR (
      stage_type = 'task_group'
      AND crawler_id IS NULL
      AND task_group_id IS NOT NULL
      AND task_group_version IS NOT NULL
      AND settings IS NOT NULL
      AND jsonb_typeof(settings) = 'object'
      AND fan_out_field IS NULL
      AND fan_out_strategy = 'compact'
      AND input_schema = '{}'::jsonb
      AND output_schema = '{}'::jsonb
    )
  );

COMMENT ON COLUMN scheduler_stages.stage_type IS 'What the stage runs: crawler or task_group';
COMMENT ON COLUMN scheduler_stages.task_group_id IS 'Task group of a task group stage';
COMMENT ON COLUMN scheduler_stages.task_group_version IS 'Registered version the stage was saved with and runs';
COMMENT ON COLUMN scheduler_stages.settings IS 'Settings the user filled in, valid for the settings schema of that version';

-- The stage can be edited or deleted while the group works, so the stage run
-- keeps the group and version it was started with.
ALTER TABLE scheduler_stage_runs
  ADD COLUMN task_group_id TEXT,
  ADD COLUMN task_group_version INTEGER,
  ADD COLUMN progress JSONB,
  ADD CONSTRAINT scheduler_stage_runs_task_group_check
    CHECK ((task_group_id IS NULL) = (task_group_version IS NULL));

COMMENT ON COLUMN scheduler_stage_runs.task_group_id IS 'Task group the stage run was started with; NULL for a crawler stage';
COMMENT ON COLUMN scheduler_stage_runs.task_group_version IS 'Version of the task group the stage run was started with';
COMMENT ON COLUMN scheduler_stage_runs.progress IS 'Latest progress a task group reported: {"message", "completed", "total", "reported_at"}';

-- A run that is closed as interrupted must not leave a stage run in progress,
-- so this function now closes the active stage runs of the runs it closes.
CREATE OR REPLACE FUNCTION fail_scheduler_runs(run_ids UUID[], failed_at TIMESTAMPTZ, failure_message TEXT)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  WITH failed_runs AS (
    UPDATE public.scheduler_runs
    SET status = 'failed', completed_at = failed_at, error = failure_message
    WHERE id = ANY(run_ids)
      AND status IN ('pending', 'running')
    RETURNING id
  ),
  failed_stage_runs AS (
    UPDATE public.scheduler_stage_runs
    SET status = 'failed', completed_at = GREATEST(failed_at, started_at), error = failure_message
    WHERE run_id IN (SELECT id FROM failed_runs)
      AND status IN ('pending', 'running')
  )
  SELECT id FROM failed_runs;
$$;
```

| 이름 | 뜻 |
| -- | -- |
| `task_groups` | 등록된 그룹. 기본 키는 `(id, version)` |
| `task_groups.worker_binding` | 그 그룹을 구현한 워커를 부를 때 쓰는 스케줄러의 service binding 이름. API로 내보내지 않는다 |
| `scheduler_stages.stage_type` | `crawler` 또는 `task_group`. 기본값 `crawler` |
| `scheduler_stages.task_group_id`, `task_group_version` | 그룹 단계가 가리키는 그룹과 버전 |
| `scheduler_stages.settings` | 그룹 단계에서 사용자가 채운 설정 |
| `scheduler_stage_runs.task_group_id`, `task_group_version` | 그 단계 실행을 시작할 때의 그룹과 버전. 크롤러 단계의 기록은 NULL |
| `scheduler_stage_runs.progress` | 그룹이 마지막으로 알린 진행 상황 |

기존 단계는 `stage_type`이 `crawler`가 되고 나머지 새 컬럼은 NULL이다. 지금 배포된 워커가 단계를 만들어도 기본값 덕분에 제약에 맞는다. 그래서 이 마이그레이션은 지금 배포된 워커와 함께 있어도 문제가 없다.

그룹 단계의 `input_schema`와 `output_schema`는 `{}`다. 그룹 단계의 형식은 그룹 등록 정보에 있고, 이 두 컬럼은 크롤러 단계가 쓰는 값이다.

`fail_scheduler_runs`는 `CREATE OR REPLACE`로 바꾸므로 011이 준 실행 권한이 그대로 남는다.

두 검토에서 이 SQL을 PGlite로 001~011 뒤에 적용해 확인했다. 구현할 때 다시 확인한다(9절).

### connector

타입(`packages/supabase-connector/sources/types/database.ts`와 `types/index.ts`, 패키지 `index.ts`의 export):

```ts
export type SchedulerStageType = 'crawler' | 'task_group';

export interface TaskGroupRow {
  [key: string]: unknown;
  id: string;
  version: number;
  input_schema: Record<string, unknown>;
  settings_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  worker_binding: string;
  created_at: string;
}

export interface SchedulerStageRunProgress {
  message: string;
  completed: number | null;
  total: number | null;
  reported_at: string;
}

/** A stage run without the input and the output, which can be large */
export type SchedulerStageRunSummary = Omit<SchedulerStageRunRow, 'input' | 'output'>;
```

- `SchedulerStageRow`에 `stage_type: SchedulerStageType`, `task_group_id: string | null`, `task_group_version: number | null`, `settings: Record<string, unknown> | null`을 더하고, `crawler_id`를 `string | null`로 바꾼다.
- `scheduler_stages`의 Insert 타입에서 `crawler_id`를 `string | null`(선택)로 바꾸고 새 컬럼 넷을 선택 필드로 더한다.
- `SchedulerStageRunRow`에 `task_group_id: string | null`, `task_group_version: number | null`, `progress: SchedulerStageRunProgress | null`을 더하고, Insert 타입에는 선택 필드로 더한다.
- `Database`의 `Tables`에 `task_groups`를 더한다.

함수. 기존 함수처럼 `traceDatabaseOperation`으로 감싸고 오류면 `Failed to …`를 던진다.

| 함수 | 하는 일 |
| -- | -- |
| `listTaskGroups(client)` | 등록된 모든 행. `id`, `version` 오름차순 |
| `getTaskGroup(client, id, version)` | 한 행. 없으면 `undefined` |
| `getSchedulerStageRunByID(client, id)` | 실행 조건 없이 `id`로 단계 실행 기록 한 행. 없으면 `undefined` |
| `getSchedulerStageRunByStage(client, runID, stageID)` | 그 실행에서 그 단계의 실행 기록. 여러 개면 가장 나중에 만든 것. 없으면 `undefined` |
| `listSchedulerStageRunSummaries(client, runID)` | 그 실행의 단계 실행 기록을 `input`·`output` 없이. `stage_order` 오름차순 |
| `getSchedulerRunByID(client, id)` | 스케줄 조건 없이 `id`로 실행 기록 한 행. 없으면 `undefined` |
| `updateSchedulerStageRun(client, id, runID, input, options?)` | 기존 함수에 `options.onlyIfStatus`를 더한다. `updateSchedulerRun`의 같은 옵션과 뜻이 같다. 조건에 맞는 행이 없으면 `undefined` |
| `setSchedulerStageRunProgress(client, id, progress)` | 상태가 `running`인 그 기록의 `progress`만 바꾼다. 바뀌었으면 `true` |
| `failActiveSchedulerStageRuns(client, runID, failedAt, failureMessage)` | 그 실행의 `pending`·`running` 단계 실행 기록을 `failed`로 닫는다. 바뀐 행 수를 돌려준다. 바뀐 행이 없어도 오류가 아니다 |

`createSchedulerStage`는 `crawler_id`가 없을 수 있으니 span 속성을 값이 있을 때만 넣는다.

## 4. 형식 검증

워커에 `sources/schema-validation.ts`를 새로 만든다.

```ts
export type SchemaValidationResult =
  | { valid: true }
  | { valid: false; path: string; message: string };

export class UnsupportedSchemaError extends Error {}

export function validateAgainstSchema(schema: unknown, value: unknown): SchemaValidationResult
```

형식은 JSON Schema이고, 아래 키워드만 쓴다.

| 키워드 | 값의 모양 | 뜻 |
| -- | -- | -- |
| `type` | 이름 하나, 또는 서로 다른 이름이 하나 이상 든 배열 | `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`. 배열이면 하나라도 맞으면 된다 |
| `enum` | 문자열·숫자·불리언·`null`이 하나 이상 든 배열 | 값이 그중 하나와 `===`로 같아야 한다 |
| `minLength`, `maxLength` | 0 이상의 정수 | 문자열 길이. 코드 포인트로 센다(`[...value].length`) |
| `minimum`, `maximum` | 유한한 수 | 숫자 범위(경계 포함) |
| `minItems`, `maxItems` | 0 이상의 정수 | 배열 길이 |
| `items` | 스키마 하나 | 배열 항목의 스키마 |
| `required` | 문자열 배열 | 객체가 그 필드를 자기 속성으로 가져야 한다(`Object.hasOwn`) |
| `properties` | 필드 이름별 스키마 | 객체에 그 필드가 있을 때 그 값을 검증한다 |
| `additionalProperties` | 불리언 | `false`면 `properties`에 없는 필드를 허용하지 않는다. `true`거나 없으면 허용한다 |
| `title`, `description`, `default`, `examples` | 아무 값 | 검증에 쓰지 않고 넘어간다 |

- 스키마는 배열이 아닌 객체여야 한다. `{}`는 무엇이든 통과시킨다.
- `number`는 유한한 수, `integer`는 `Number.isInteger`가 참인 수다. `object`는 배열과 `null`이 아닌 객체다.
- 키워드는 해당 타입의 값에만 적용한다. `minLength`는 값이 문자열일 때만, `properties`는 값이 객체일 때만 본다.
- 표에 없는 키워드가 있거나 키워드의 값이 표의 모양과 다르면(`type: 'date'`, `type: []`, `additionalProperties: {}`, `items: []`, `minLength: -1` 등) `UnsupportedSchemaError`를 던진다. 스케줄러가 읽지 못하는 형식을 통과로 처리하지 않기 위해서다. 값을 보기 전에 스키마 전체를 먼저 살펴보고 던지므로, 값이 그 부분에 닿지 않아도 던진다.
- 깊이는 최상위 스키마가 1이고, `properties`의 스키마와 `items`의 스키마가 그보다 1 깊다. 깊이 33인 스키마가 있으면 `UnsupportedSchemaError`다.
- 처음 만난 어긋남 하나만 돌려준다. 값 하나를 보는 순서는 `type`, `enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`(항목 순서대로), `required`(적힌 순서), `properties`(스키마에 적힌 순서), `additionalProperties`(값의 필드 순서)다.
- `path`는 `$`에서 시작한다: `$`, `$.title`, `$.items[2].url`. 필드 이름이 `[A-Za-z_][A-Za-z0-9_]*`에 맞지 않으면 `` `[${JSON.stringify(이름)}]` ``로 쓴다: `$["field name"]`.

`message`는 아래 문구다.

| 어긋남 | `message` |
| -- | -- |
| 타입 | `must be of type string`. 둘이면 `must be of type string or null`, 셋 이상이면 `must be of type string, number or null`(스키마에 적힌 순서) |
| 없는 필수 필드(`path`는 그 필드) | `is required` |
| 허용하지 않는 필드(`path`는 그 필드) | `is not allowed` |
| `enum` | `must be one of: "a", "b", 3` (값을 `JSON.stringify`로 쓰고 `, `로 잇는다) |
| `minLength` / `maxLength` | `must be at least 3 characters long` / `must be at most 80 characters long` |
| `minimum` / `maximum` | `must be at least 1` / `must be at most 10` |
| `minItems` / `maxItems` | `must have at least 1 items` / `must have at most 20 items` |

## 5. API

### 그룹 목록

`GET /task-groups`. `/schedulers`와 같은 JWT 인증을 거친다. 다른 메서드는 `405`(`Allow: GET`)다.

```json
{ "data": [ { "id": "newscast", "version": 1, "input_schema": {}, "settings_schema": {}, "output_schema": {}, "created_at": "…" } ] }
```

등록된 모든 버전을 `id`, `version` 오름차순으로 돌려준다. `worker_binding`은 넣지 않는다. 등록된 그룹이 없으면 `data`는 빈 배열이다. `HELP`에 이 경로를 더한다.

### 단계 만들기

`POST /schedulers/:id/stages`가 `stage_type`(선택)을 받는다. 없거나 `crawler`면 크롤러 단계이고 지금과 같은 검증·순서·문구로 동작한다. 아래 검사는 모두 `400 invalid_request`다.

| 조건 | `error_description` |
| -- | -- |
| `stage_type`이 있는데 `crawler`도 `task_group`도 아님 | `Field 'stage_type' must be 'crawler' or 'task_group'` |
| 크롤러 단계인데 `task_group_id`, `task_group_version`, `settings` 중 하나가 있음 | `Field '<이름>' is not allowed on a crawler stage` |
| 그룹 단계인데 `crawler_id`, `input_schema`, `output_schema`, `fan_out_field`, `fan_out_strategy` 중 하나가 있음 | `Field '<이름>' is not allowed on a task group stage` |
| `task_group_id`가 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`에 맞는 63자 이하의 문자열이 아님 | `Field 'task_group_id' is required and must be a task group ID` |
| `task_group_version`이 1 이상의 정수가 아님 | `Field 'task_group_version' is required and must be a positive integer` |
| `stage_order` | 지금 문구 그대로 |
| `settings`가 배열이 아닌 객체가 아님 | `Field 'settings' is required and must be a JSON object` |
| 그 그룹·버전이 등록되지 않음 | `Task group '<id>' version <버전> is not registered` |
| 설정이 설정 형식에 맞지 않음 | `Field 'settings' does not match the task group settings format: <path> <message>` |

"있음"은 값이 `undefined`가 아니라는 뜻이다. 검사 순서는 표의 순서이고, 이름이 여럿인 줄은 적힌 순서로 본다. `stage_type` 검사는 요청 본문이 객체인지 본 바로 뒤에 한다. 크롤러 단계의 둘째 줄 검사는 지금의 `crawler_id` 검사보다 앞에 둔다.

그룹 단계는 `stage_type: 'task_group'`, `crawler_id: null`, `task_group_id`, `task_group_version`, `settings`, `stage_order`, `input_schema: {}`로 저장한다. 순서가 겹치면 지금처럼 `409`다. 응답은 지금처럼 저장된 행이다.

설정 형식을 읽지 못하면(`UnsupportedSchemaError`) 오류를 로그로 남기고 `500 server_error`(`Task group format cannot be read`)를 돌려준다. 등록 정보의 문제이지 사용자의 문제가 아니다.

`task_group_version`이 DB의 INTEGER 범위(2147483647)를 넘으면 조회하지 않고 등록되지 않은 것으로 본다. 확인한 뒤 저장하기 전에 그 버전이 지워져 DB가 외래 키로 거절하면, 그룹 단계에서는 같은 문구(`Task group '<id>' version <버전> is not registered`)의 `400`으로 바꾼다. 크롤러 단계의 외래 키 문구는 지금 그대로다. 고칠 때도 같다.

### 단계 고치기

`PUT /schedulers/:id/stages/:stageID`가 `settings`와 `task_group_version`을 받는다. 이제 고치기 전에 항상 그 단계를 먼저 읽는다. 종류에 따라 받을 수 있는 필드가 다르기 때문이다. 요청 본문이 객체인지 본 바로 뒤에 아래 순서로 한다.

1. 본문에 `stage_type`이나 `task_group_id`가 있으면 `400`(`Field '<이름>' cannot be changed`)이다. 단계의 종류나 그룹을 바꾸려면 지우고 새로 만든다.
2. 단계를 읽는다. 없으면 `404`(`Stage not found`)다.
3. 크롤러 단계면: 본문에 `task_group_version`이나 `settings`가 있으면 `400`(`Field '<이름>' is not allowed on a crawler stage`)이다. 그 뒤는 지금과 같은 검증·순서·문구다.
4. 그룹 단계면:
   - 본문에 `crawler_id`, `input_schema`, `output_schema`, `fan_out_field`, `fan_out_strategy` 중 하나가 있으면 `400`(`Field '<이름>' is not allowed on a task group stage`)이다. 크롤러 권한은 확인하지 않는다.
   - `task_group_version`이 있는데 1 이상의 정수가 아니면 `400`(`Field 'task_group_version' must be a positive integer`).
   - `settings`가 있는데 배열이 아닌 객체가 아니면 `400`(`Field 'settings' must be a JSON object`).
   - 둘 다 없으면 `400`(`At least one field must be provided for update`).
   - 저장될 버전(본문 값, 없으면 지금 값)이 등록됐는지 보고, 저장될 설정(본문 값, 없으면 지금 값)을 그 버전의 설정 형식으로 검증한다. 문구와 `500` 처리는 만들 때와 같다.
   - 본문에 있는 필드만 저장한다.

DB가 `scheduler_stages_type_check`로 거절하면(읽은 뒤에 단계가 바뀐 경우) `400`(`Stage fields do not match the stage type`)으로 바꾼다. 이 검사는 기존의 외래 키·중복 검사보다 앞에 둔다.

### 실행 기록

`GET /schedulers/:id/runs/:runID` 응답에 `stage_runs`를 더한다. 그 실행의 단계 실행 기록을 `input`·`output` 없이 `stage_order` 오름차순으로 넣는다(`listSchedulerStageRunSummaries`). 그룹이 알린 진행 상황은 각 기록의 `progress`에 있다. 목록(`GET /schedulers/:id/runs`)은 바꾸지 않는다.

### 수동 실행

`POST /schedulers/:id/execute`:

1. 지금처럼 소유자를 확인하고 실행 기록(`pending`)을 만든다. 진행 중인 실행이 있으면 지금처럼 `409`다.
2. 단계 목록을 읽는다.
3. 그룹 단계가 하나도 없으면 지금처럼 요청 안에서 실행하고 지금과 같은 응답을 준다. 읽은 단계 목록은 `executeScheduler`에 넘겨 다시 읽지 않게 한다.
4. 그룹 단계가 있으면 Workflow 인스턴스를 만들고 바로 `202`로 응답한다. 인스턴스 ID는 `manual-<실행 기록 ID>`, 인자는 `{ schedulerID, runID }`다. 응답 본문은 지금과 같은 모양이다: `{ run_id, status: 'pending', result: null, error: null, started_at: null, completed_at: null }`.

2가 실패하면 그룹 단계가 없는 것으로 보고 3으로 간다. 이때는 목록을 넘기지 않는다. `executeScheduler`가 지금처럼 목록을 다시 읽고, 또 실패하면 지금처럼 실행 기록에 실패를 남기고 지금과 같은 응답을 준다. 크롤러 단계만 있는 스케줄의 동작이 실패할 때도 지금과 같게 하기 위해서다.

4에서 인스턴스 만들기가 실패하면 실행 기록을 `failed`(`completed_at`, `error: 'Run could not be started'`, `onlyIfStatus: ['pending']`)로 닫고 오류를 다시 던진다. 응답은 지금의 `500`이다.

## 6. 그룹의 워커와 주고받는 것

이 절이 스케줄러와 그룹 사이의 약속 전부다. 스케줄러는 그룹의 코드를 가져다 쓰지 않고, 그룹은 아래 두 가지만 지키면 된다.

### 스케줄러가 그룹을 시작시킨다

워커에 `sources/task-group-worker.ts`를 새로 만든다.

```ts
export interface TaskGroupStartRequest {
  /** Identifies this stage run in every report. Starting twice with the same value must not run the group twice. */
  stageRunID: string;
  taskGroupID: string;
  taskGroupVersion: number;
  /** Output of the previous stage, already checked against the input schema */
  input: unknown;
  /** Settings saved on the stage, valid for the settings schema */
  settings: Record<string, unknown>;
  /** Owner of the scheduler */
  userUUID: string;
}

export interface TaskGroupWorker {
  startTaskGroupRun(request: TaskGroupStartRequest): Promise<void>;
}

export const TASK_GROUP_STAGE_TIMEOUT_MINUTES = 60;

export function resolveTaskGroupWorker(environment: object, binding: string): TaskGroupWorker | undefined
export function taskGroupFinishedEventType(stageRunID: string): string
```

- 그룹의 워커는 binding의 entrypoint에 RPC 메서드 `startTaskGroupRun`을 둔다. 이 호출은 일을 시작만 하고 바로 돌아온다. 던지면 스케줄러는 그 단계를 실패로 기록한다.
- 같은 `stageRunID`로 시작 요청이 다시 올 수 있다(스케줄러의 step이 다시 실행된 경우). 그룹은 이미 시작한 실행이면 아무것도 하지 않고 돌아온다.
- `resolveTaskGroupWorker`는 `environment`가 그 이름을 자기 속성으로 가지고 값이 `null`이 아닌 객체일 때만 돌려준다. 없거나 문자열이면 `undefined`다.
- `taskGroupFinishedEventType`은 `` `task-group-finished-${stageRunID}` ``다. 56자이고 Workflows의 이벤트 종류 규칙(영숫자·`-`·`_`, 100자 이하)에 맞는다.

### 그룹이 스케줄러에 알린다

스케줄러 워커가 이름 있는 entrypoint `TaskGroupReports`를 export한다. 그룹의 워커는 자기 `wrangler.toml`에서 이 entrypoint에 service binding을 건다(10절).

```ts
// sources/task-group-reports.ts
export interface TaskGroupProgressReport { message: string; completed?: number; total?: number }
export interface TaskGroupReportResult { accepted: boolean }

export interface TaskGroupReportDependencies {
  supabaseClient: SupabaseClient;
  workflow: Pick<Workflow, 'get'>;
  logger: Logger;
}

export async function reportTaskGroupProgress(dependencies, stageRunID: string, progress: TaskGroupProgressReport): Promise<TaskGroupReportResult>
export async function completeTaskGroupRun(dependencies, stageRunID: string, output: unknown): Promise<TaskGroupReportResult>
export async function failTaskGroupRun(dependencies, stageRunID: string, errorMessage: string): Promise<TaskGroupReportResult>
```

```ts
// sources/task-group-reports-entrypoint.ts
export class TaskGroupReports extends WorkerEntrypoint<Environment> {
  async fetch(): Promise<Response>            // 404
  async reportProgress(stageRunID: string, progress: TaskGroupProgressReport): Promise<TaskGroupReportResult>
  async complete(stageRunID: string, output: unknown): Promise<TaskGroupReportResult>
  async fail(stageRunID: string, errorMessage: string): Promise<TaskGroupReportResult>
}
```

클래스는 환경에서 Supabase client를 만들어 위 함수를 부르기만 한다. `sources/index.ts`가 이 클래스를 export한다.

`accepted`가 `true`면 그 단계 실행이 알림과 같은 결과로 끝났다는 뜻이다(완료 알림이면 `completed`, 실패 알림이면 `failed`, 진행 알림이면 저장됨). `false`면 다르게 끝났거나 그런 실행이 없다는 뜻이고, 그룹은 하던 일을 그만둬도 된다. 같은 알림을 여러 번 보내도 결과는 같다.

알림이 던지면 그룹은 같은 알림을 다시 보낸다. 단, `TypeError`는 인자가 틀린 것이므로 다시 보내지 않는다.

**인자 검사.** 아래에 해당하면 `TypeError`를 던진다. `stageRunID`가 UUID가 아님. `message`가 1~500자의 문자열이 아님. `completed`·`total`이 있는데(`undefined`가 아닌데) 0 이상의 정수가 아니거나, 둘 다 있는데 `completed > total`임. `errorMessage`가 문자열이 아님. `errorMessage`는 앞에서 2,000자까지만 쓴다. 글자 수는 4절처럼 코드 포인트로 센다.

**`reportTaskGroupProgress`.** `setSchedulerStageRunProgress`로 `{ message, completed: completed ?? null, total: total ?? null, reported_at }`를 저장한다. 바뀌었으면 `accepted: true`다. Supabase 요청은 한 번이다.

**`completeTaskGroupRun`.**

1. 단계 실행 기록을 `getSchedulerStageRunByID`로 읽는다. 없거나 `task_group_id`가 NULL이면(크롤러 단계의 기록) `accepted: false`.
2. 상태가 `running`이 아니면 인스턴스를 깨우고(아래) 끝낸다. `accepted`는 상태가 `completed`일 때만 `true`다.
3. 기록에 적힌 그룹과 버전으로 등록 정보를 읽어 출력을 출력 형식으로 검증한다.
   - 맞으면 기록을 `completed`로 바꾼다: `completed_at`, `output`. `onlyIfStatus: ['running']` 조건을 건다.
   - 맞지 않으면 경고 로그를 남기고 기록을 `failed`로 바꾼다(같은 조건). `error`는 `Stage <순서>: output does not match the task group output format: <path> <message>`다. 로그에는 단계 실행 ID, 그룹, 버전, 어긋난 곳만 넣고 출력 내용은 넣지 않는다.
   - 등록 정보가 없거나 형식을 읽지 못하면 로그를 남기고 기록을 `failed`로 바꾼다(같은 조건). `error`는 `Stage <순서>: task group output format cannot be read`다.
   - 출력이 `undefined`면 `null`로 본다. `null`을 검증하고 `null`을 저장한다. JSON에는 `undefined`가 없어, 그대로 두면 검증한 값과 저장된 값이 달라진다.
4. 3에서 조건에 걸려 바뀌지 않았으면(그 사이에 다르게 끝난 것이다) 기록을 다시 읽는다.
5. 인스턴스를 깨운다. `accepted`는 기록의 마지막 상태가 `completed`일 때만 `true`다.

**`failTaskGroupRun`.** 1은 같다. 상태가 `running`이 아니면 인스턴스를 깨우고 끝내며, `accepted`는 상태가 `failed`일 때만 `true`다. `running`이면 `failed`로 바꾼다: `completed_at`, `error: 'Stage <순서>: task group failed: <errorMessage>'`, `onlyIfStatus: ['running']`. 조건에 걸리면 다시 읽는다. 인스턴스를 깨우고, `accepted`는 마지막 상태가 `failed`일 때만 `true`다.

`<순서>`는 단계 실행 기록의 `stage_order`다.

**인스턴스 깨우기.** 실행 기록을 `getSchedulerRunByID`로 읽어 인스턴스 ID를 구한다(7절 `runInstanceID`). `workflow.get(인스턴스 ID)`로 인스턴스를 얻어 `sendEvent({ type: taskGroupFinishedEventType(stageRunID), payload: { stageRunID } })`를 부른다.

- 실행 기록이 없거나 `pending`·`running`이 아니면 깨울 것이 없다. 보내지 않는다.
- 실행이 진행 중인데 `get`이나 `sendEvent`가 던지면 그 오류를 다시 던진다. 그룹이 알림을 다시 보내면 2에서 이미 끝난 기록을 보고 깨우기만 다시 한다.

이벤트는 인스턴스가 `waitForEvent`에 닿기 전에 보내도 된다. Workflows가 보관했다가 전달한다(12절).

단계나 스케줄이 지워져 단계 실행 기록이 사라졌으면 알림은 `accepted: false`이고 깨울 수 없다. 그 인스턴스는 제한 시간에 깨어나 실패로 끝난다(7절).

## 7. 실행

### 인스턴스 ID

`sources/schedule.ts`에 더한다.

```ts
export function manualRunInstanceID(runID: string): string        // `manual-${runID}`
export function runInstanceID(run: Pick<SchedulerRunRow, 'id' | 'scheduler_id' | 'triggered_by' | 'scheduled_for'>): string
```

`runInstanceID`는 예약 실행(`triggered_by === 'schedule'`이고 `scheduled_for`가 있음)이면 지금의 `schedulerRunInstanceID`를, 아니면 `manualRunInstanceID`를 돌려준다.

### Workflow

`SchedulerRunParameters`가 두 모양이 된다. 이미 만들어진 인스턴스의 인자는 첫째 모양이라 그대로 동작한다.

```ts
export type SchedulerRunParameters =
  | { schedulerID: string; scheduledFor: string }   // 예약 실행
  | { schedulerID: string; runID: string };          // 그룹 단계가 있는 수동 실행
```

`runScheduledPipeline`의 의존성에 그룹 워커를 찾는 함수를 더하고, `step`에 `waitForEvent`를 더한다.

```ts
export interface ScheduledPipelineDependencies extends ExecutorDependencies {
  resolveTaskGroupWorker: (binding: string) => TaskGroupWorker | undefined;
}

export interface ScheduledPipelineStep {
  do<T>(name: string, options: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  waitForEvent(name: string, options: { type: string; timeout: WorkflowTimeoutDuration }): Promise<unknown>;
}
```

`timeout`의 타입은 `cloudflare:workers`의 `WorkflowTimeoutDuration`이다. 그냥 `string`이면 실제 `WorkflowStep`을 넘길 수 없다.

`SchedulerRunWorkflow`는 `resolveTaskGroupWorker: (binding) => resolveTaskGroupWorker(this.env, binding)`을 넘긴다.

**`begin-run`.** 예약 실행은 지금과 같다. 수동 실행(`runID`가 있음)은 이렇게 한다.

1. 스케줄을 `getSchedulerByID`로 읽는다. 없으면 `cancelled`다. 켜져 있는지와 cron 식은 보지 않는다.
2. 실행 기록을 `getSchedulerRun(client, runID, schedulerID)`로 읽는다. 없으면 `cancelled`다.
3. `pending`이면 `running`으로 바꾸고(`started_at`, `onlyIfStatus: ['pending']`) 시작한다. 바뀌지 않았으면 다시 읽는다. 기록이 없어졌으면 `cancelled`, `running`이면 시작, 그 밖이면 `finished`다. 처음 읽은 기록이 `running`이면 그대로 이어서 시작한다(step이 다시 실행된 것이다). 그 밖이면 `finished`다.

**단계.** 단계마다 `stage_type`이 `task_group`일 때만 그룹 단계로 다룬다. 그 밖(값이 없는 것 포함)은 크롤러 단계이고 지금과 같다.

그룹 단계는 step 세 개다. 로직은 `sources/task-group-stage.ts`에 둔다.

| step | 설정 | 하는 일 |
| -- | -- | -- |
| `stage-<순서>` | 재시도 없음, 5분 | 입력을 검증하고 그룹을 시작시킨다 |
| `stage-<순서>-finished` | `waitForEvent`, 60분 | 완료 이벤트를 기다린다 |
| `stage-<순서>-result` | 5회, 1분(기록 step 설정) | 단계 실행 기록을 읽어 결과를 정한다 |

`stage-<순서>`(시작). Workflows는 끝나지 못한 step을 다시 실행할 수 있다. 그래서 이미 만든 기록이 있으면 그것을 쓴다.

1. `getSchedulerStageRunByStage`로 이 실행에서 이 단계의 기록을 찾는다.
   - 있고 `running`이면 새 기록을 만들지 않는다. 그 기록에 적힌 그룹·버전으로 등록 정보와 워커를 찾고, 그 기록의 ID와 `input`으로 7을 한다. 등록 정보나 워커가 없으면 그 기록을 3·5의 문구로 `failed`로 바꾸고(`onlyIfStatus: ['running']`) 실패다.
   - 있고 `running`이 아니면 `{ status: 'settled', stageRunID }`를 돌려준다. 기다리지 않고 결과 step으로 간다.
2. 입력을 정한다. 앞 단계가 있으면 그 단계 실행 기록의 `output`이다(지금 방식). 첫 단계면 `{}`다.
3. 그룹 등록 정보를 읽는다. 없으면 실패다: `Stage <순서>: task group '<id>' version <버전> is not registered`. 이때는 기록을 만들지 않는다.
4. 입력을 입력 형식으로 검증한다. 맞지 않으면 단계 실행 기록을 처음부터 `failed`로 만들고 실패다: `Stage <순서>: input does not match the task group input format: <path> <message>`. 형식을 읽지 못하면 같은 방식으로 `Stage <순서>: task group input format cannot be read`다. 그룹은 시작하지 않는다.
5. 그룹의 워커를 찾는다. 없으면 4처럼 `failed` 기록을 만들고 실패다: `Stage <순서>: task group worker '<binding>' is not connected`.
6. 단계 실행 기록을 `running`으로 만든다(1에서 찾았으면 만들지 않는다).
7. `startTaskGroupRun`을 부른다. 인자는 6절의 `TaskGroupStartRequest`이고 `userUUID`는 스케줄의 소유자다. 던지면 기록을 `failed`로 바꾸고(`onlyIfStatus: ['running']`) 실패다: `Stage <순서>: task group could not be started: <오류 문구>`.
8. `{ status: 'waiting', stageRunID }`를 돌려준다.

만드는 기록에는 모두 `task_group_id`, `task_group_version`, `input`, `started_at`을 넣고, `failed`로 만드는 기록에는 `completed_at`과 `error`도 넣는다. 그룹에 넘기는 `settings`는 `load-stages`가 읽은 단계의 값이다.

실패는 지금의 크롤러 단계처럼 `{ status: 'failed', error }`로 돌려주고 던지지 않는다.

`running` 기록을 `failed`로 바꾸려는데 조건에 걸려 바뀌지 않으면, 그 사이에 그룹이 알림을 보내 기록이 이미 끝난 것이다. 이때는 실패가 아니라 `{ status: 'settled', stageRunID }`를 돌려주고 결과 step이 기록에서 결과를 정한다.

`stage-<순서>-finished`(대기). 시작 step이 `waiting`을 돌려줬을 때만 한다. `step.waitForEvent(이름, { type: taskGroupFinishedEventType(stageRunID), timeout: '60 minutes' })`. 제한 시간을 넘기면 던지는데, 이 오류는 잡아 경고 로그로 남기고 다음 step으로 간다. 다른 오류도 같게 다룬다. 결과는 다음 step이 DB에서 정한다.

`stage-<순서>-result`(결과). 시작 step이 `waiting`이나 `settled`를 돌려줬을 때 한다.

1. 단계 실행 기록을 읽는다. 없으면(단계나 스케줄이 지워진 것이다) `{ status: 'failed', error: 'Stage <순서>: stage run record was removed' }`다.
2. `running`이면 끝났다는 알림이 오지 않은 것이다. `failed`로 바꾼다: `completed_at`, `error: 'Stage <순서>: task group did not finish within 60 minutes'`, `onlyIfStatus: ['running']`. 조건에 걸려 바뀌지 않았으면(그 사이에 알림이 온 것이다) 다시 읽는다.
3. `completed`면 `{ status: 'completed', stageRunID }`, 아니면 `{ status: 'failed', error: 기록의 error ?? 'Stage <순서>: task group failed' }`를 돌려준다.

그 뒤는 지금과 같다. 실패면 남은 단계를 실행하지 않는다. 성공이면 다음 단계가 이 기록의 `output`을 입력으로 읽고, 마지막 단계면 `finish-run`이 그 `output`을 회차의 결과로 저장한다. 어떤 step 반환값에도 단계의 출력은 없다.

**`finish-run`.** 실행 기록을 닫기 전에 `failActiveSchedulerStageRuns`로 그 실행의 진행 중인 단계 실행 기록을 닫는다(`error: 'Run ended before this stage finished'`). 결과와 관계없이 항상 한다. step이 제한 시간을 넘겨 던졌거나 시작 step이 다시 실행돼 기록이 남은 경우에 `running`으로 남지 않게 한다. 크롤러 단계에도 적용된다.

### 요청 안에서 실행하는 경로

- `executeScheduler`가 단계 목록을 선택 인자(마지막)로 받는다. 받으면 읽지 않고, 안 받으면 지금처럼 읽는다.
- `executePipelineStage`는 그룹 단계를 받으면 `Stage <순서>: a task group stage cannot run in a direct execution`을 던진다. 수동 실행 요청이 단계 목록을 읽은 뒤에 그룹 단계가 추가된 경우에만 닿는다.
- `stage-runner.ts`의 함수들은 크롤러가 있는 단계(`SchedulerStageRow & { crawler_id: string }`)를 받는다. `executePipelineStage`가 `crawler_id`가 `null`이면 `Stage <순서>: crawler is missing`을 던져 타입을 좁힌다.

### tick

`schedule-tick.ts`의 인스턴스 확인이 모든 실행 기록에 `runInstanceID`를 쓴다. 지금은 수동 실행 기록을 인스턴스 확인 없이 10분 뒤에 닫는데, 이제 그룹 단계가 있는 수동 실행은 인스턴스가 살아 있는 동안 닫지 않는다. 요청 안에서 실행한 수동 기록은 인스턴스가 없어 `get`이 던지므로 지금처럼 닫힌다.

그룹 단계를 기다리는 인스턴스는 `waiting` 상태이고, tick은 이미 이 상태를 살아 있는 것으로 본다. 그동안 실행 기록은 `running`이라 다음 회차는 05의 규칙대로 건너뛰고 기록된다. 바꿀 것이 없다.

tick이 실행을 닫으면 바뀐 `fail_scheduler_runs`가 그 실행의 진행 중인 단계 실행 기록도 함께 닫는다. 그 뒤에 온 알림은 `accepted: false`다.

## 8. 웹

편집 화면은 이번에 만들지 않는다. 그룹 단계가 있는 스케줄을 열어도 지금 화면이 깨지지 않게만 한다.

웹은 단계 타입으로 connector의 `SchedulerStageRow`를 쓴다. `crawler_id`가 `string | null`이 되면 `StageCard`가 `null`을 다뤄야 한다. 지금은 `null`이면 화면이 죽는다. `StageCard`는 그룹 단계면 크롤러 이름 자리에 `Task group <id> v<버전>`을 보여 준다. 그룹 단계가 아닌데 `crawler_id`가 `null`인 단계는 DB 제약 때문에 있을 수 없지만, 타입으로는 가능하므로 `Unknown stage`를 보여 준다. 지우기와 순서 바꾸기는 그대로 된다. `use-scheduler-manager.ts`의 요청 타입(`CreateStageInput`, `UpdateStageInput`)은 바꾸지 않는다.

## 9. 테스트

Workflow 인스턴스를 실제로 만드는 테스트는 쓰지 않는다(05와 같은 이유). `workflow`, `step`, 그룹 워커는 fake를 넣고, Supabase는 기존 테스트 방식대로 흉내 낸다.

**기존 테스트.**

- `scheduler-executor.test.ts`, `stage-runner.test.ts`, `scheduler-execution.test.ts`는 한 글자도 고치지 않고 통과해야 한다.
- 아래는 적힌 범위만 고친다. 기존 사례와 기대값은 그대로 둔다.
  - `scheduled-pipeline.test.ts`: 가짜 Supabase가 여러 행을 바꾸는 PATCH(`failActiveSchedulerStageRuns`, 0행 포함)와 새 조회를 받게 하고, 의존성에 `resolveTaskGroupWorker`를, `step`에 `waitForEvent`를 더한다.
  - `schedule-tick.test.ts`: 수동 실행 기록을 닫는 사례는 `workflow.get`을 부르지 않는다고 확인했는데, 이제 tick이 모든 기록의 인스턴스를 확인하므로 `manual-<실행 ID>`로 불렀다고 확인하게 바꾼다. 기존 테스트에서 기대값이 바뀌는 곳은 이 한 줄뿐이다.
  - `index.test.ts`: 실행 기록 한 건 조회 사례에 단계 실행 기록 조회를 더한다. 단계 고치기 사례는 이 파일에 없어 새 테스트 파일에 쓴다.

**마이그레이션.** PGlite에서 001~012를 차례로 적용한다.

- 011까지 적용한 뒤 넣은 기존 단계가 012 뒤에 `stage_type = 'crawler'`이고 제약에 맞는다.
- `stage_type` 없이 크롤러 단계를 넣을 수 있다(지금 배포된 워커의 요청).
- 등록되지 않은 그룹·버전을 가리키는 그룹 단계는 외래 키로 거절된다.
- 그룹 단계에 `crawler_id`, `fan_out_field`, `{}`가 아닌 `input_schema`를 넣으면 `scheduler_stages_type_check`로 거절된다. 크롤러 단계에 `settings`를 넣어도 거절된다.
- `task_groups`의 형식 컬럼을 바꾸는 UPDATE는 trigger가 막고, `worker_binding`만 바꾸는 UPDATE는 된다.
- 단계가 가리키는 그룹 행은 지울 수 없다.
- 형식에 맞지 않는 `id`(`News`, `a-`, 64자), `version` 0, `worker_binding`(`newscast`)은 거절된다.
- 단계 실행 기록에 `task_group_id`만 넣고 `task_group_version`을 비우면 거절된다.
- `fail_scheduler_runs`가 닫은 실행의 `pending`·`running` 단계 실행 기록이 `failed`가 되고, 끝난 단계 실행 기록과 다른 실행의 기록은 그대로다. 011이 준 실행 권한이 그대로다.

**connector.** 새 함수마다 조회 조건, 행이 있을 때와 없을 때의 반환, 오류일 때 던지는 것을 확인한다. `updateSchedulerStageRun`의 `onlyIfStatus`가 조건을 걸고, 맞는 행이 없으면 `undefined`인지 확인한다. `failActiveSchedulerStageRuns`는 바뀐 행이 없으면 0을 돌려준다. `listSchedulerStageRunSummaries`는 `input`·`output`을 요청하지 않는다.

**형식 검증.**

| 스키마 | 값 | 결과 |
| -- | -- | -- |
| `{}` | `42` | 통과 |
| `{ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }` | `{ title: 'a' }` | 통과 |
| 같은 스키마 | `{}` | `$.title` `is required` |
| 같은 스키마 | `{ title: 1 }` | `$.title` `must be of type string` |
| 같은 스키마 | `[]` | `$` `must be of type object` |
| 위에 `additionalProperties: false` | `{ title: 'a', extra: 1 }` | `$.extra` `is not allowed` |
| `{ type: 'array', items: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }` | `[{ url: 'a' }, {}]` | `$[1].url` `is required` |
| `{ type: ['string', 'null'] }` | `null` | 통과 |
| 같은 스키마 | `1` | `$` `must be of type string or null` |
| `{ type: ['string', 'number', 'null'] }` | `true` | `$` `must be of type string, number or null` |
| `{ type: 'integer', minimum: 1, maximum: 10 }` | `1.5` | `$` `must be of type integer` |
| 같은 스키마 | `0` | `$` `must be at least 1` |
| `{ type: 'number' }` | `NaN` | `$` `must be of type number` |
| `{ enum: ['a', 'b', 3] }` | `'c'` | `$` `must be one of: "a", "b", 3` |
| `{ type: 'string', enum: ['a'], minLength: 3 }` | `'ab'` | `$` `must be one of: "a"` (`enum`이 먼저다) |
| `{ type: 'string', minLength: 3 }` | `'ab'` | `$` `must be at least 3 characters long` |
| `{ type: 'string', maxLength: 2 }` | `'😀😀'` | 통과(코드 포인트 2개) |
| `{ type: 'array', maxItems: 1 }` | `[1, 2]` | `$` `must have at most 1 items` |
| `{ type: 'object', properties: { 'field name': { type: 'string' } } }` | `{ 'field name': 1 }` | `$["field name"]` `must be of type string` |
| `{ type: 'object', required: ['toString'] }` | `{}` | `$.toString` `is required` (자기 속성만 본다) |
| `{ oneOf: [] }`, `{ type: 'date' }`, `{ type: [] }`, `{ additionalProperties: {} }`, `{ items: [] }`, `{ minLength: -1 }`, `{ properties: { a: { pattern: 'x' } } }`(값은 `{}`) | 아무 값 | `UnsupportedSchemaError` |
| 스키마가 객체가 아님(`null`, `'string'`, `[]`) | 아무 값 | `UnsupportedSchemaError` |
| `properties`로 32겹 겹친 스키마(깊이 32) | 아무 값 | 던지지 않는다 |
| 33겹 겹친 스키마(깊이 33) | 아무 값 | `UnsupportedSchemaError` |

**그룹 목록.** 인증 없이 `401`. 등록된 그룹이 없으면 `data`가 빈 배열. 있으면 `id`, `version` 순서이고 `worker_binding`이 없다. `POST`는 `405`.

**단계 저장.** 5절 표의 조건마다 `400`과 그 문구가 나온다. 맞는 요청은 `201`이고 저장 요청에 `stage_type`, `crawler_id: null`, `task_group_id`, `task_group_version`, `settings`, `input_schema: {}`가 들어간다. `stage_type` 없는 크롤러 단계 요청은 지금과 같은 요청을 보낸다. 고칠 때: `settings`만, `task_group_version`만, 둘 다 바꾸는 경우의 검증과 저장. 크롤러 단계에 `settings`를 보내면 `400`. 그룹 단계에 `crawler_id`를 보내면 `400`이고 크롤러 권한을 조회하지 않는다. `stage_type`·`task_group_id`를 보내면 단계를 읽지 않고 `400`. 단계가 없으면 `404`. 설정 형식을 읽지 못하면 `500`.

**알림.** fake `workflow`의 `get`이 돌려준 인스턴스의 `sendEvent` 호출을 본다.

- 진행: `running`인 기록에 `progress`가 저장되고 `accepted: true`. 끝난 기록이면 `accepted: false`. 인자가 틀리면 `TypeError`.
- 완료: 기록이 `completed`·`output`으로 바뀌고, `task-group-finished-<단계 실행 ID>` 이벤트가 그 실행의 인스턴스 ID로 간다. 예약 실행은 `<스케줄 ID>-<분>`, 수동 실행은 `manual-<실행 ID>`다.
- 같은 완료를 다시 보내면 기록은 바꾸지 않고 이벤트만 다시 보내며 `accepted: true`다.
- 출력이 출력 형식에 맞지 않으면 기록이 `failed`가 되고 이벤트가 가며 `accepted: false`다. 같은 알림을 다시 보내면 이벤트만 다시 가고 `accepted: false`다.
- 출력은 기록에 적힌 버전의 형식으로 검증한다. 단계가 그 사이에 다른 버전으로 바뀌었거나 지워졌어도 같다(단계를 읽지 않는다).
- 이미 `failed`인 기록(제한 시간 초과)에 완료를 보내면 `accepted: false`이고 기록은 바뀌지 않는다.
- 실패: 기록이 `failed`·`Stage <순서>: task group failed: <문구>`로 바뀌고 이벤트가 가며 `accepted: true`다. 이미 `completed`인 기록이면 `accepted: false`다.
- 기록이 없는 ID, 크롤러 단계의 기록이면 `accepted: false`이고 아무것도 바꾸지 않는다.
- 실행이 진행 중인데 `sendEvent`가 던지면 알림도 던진다. 실행이 이미 끝났으면 보내지 않고 던지지도 않는다.

**회차 실행.** `step.do`가 callback을 바로 부르고 `waitForEvent`를 설정할 수 있는 fake로 확인한다.

- 크롤러 → 그룹 → 크롤러: step 이름이 `begin-run`, `load-stages`, `stage-0`, `stage-1`, `stage-1-finished`, `stage-1-result`, `stage-2`, `finish-run` 순서다. 그룹은 `stage-0`의 출력, 단계의 설정, 스케줄 소유자를 받는다. `stage-2`의 입력은 그룹이 알린 출력이다(fake `waitForEvent` 안에서 `completeTaskGroupRun`을 불러 흉내 낸다). 기록은 `completed`다.
- 그룹이 마지막 단계면 회차의 `result`가 그룹의 출력이다.
- 그룹이 첫 단계면 입력이 `{}`다.
- step 설정이 7절 표와 같고, `waitForEvent`의 `type`과 `timeout`이 맞다.
- 만든 단계 실행 기록에 `task_group_id`와 `task_group_version`이 있다.
- 입력이 입력 형식에 맞지 않으면 그룹을 부르지 않고, `failed` 단계 실행 기록이 만들어지며, 회차는 `failed`이고 남은 단계를 실행하지 않는다. `waitForEvent`도 부르지 않는다.
- binding이 없으면, `startTaskGroupRun`이 던지면 각각 7절의 문구로 실패한다.
- 시작 step이 다시 실행된 경우: 이 단계의 `running` 기록이 이미 있으면 새 기록을 만들지 않고 같은 `stageRunID`로 `startTaskGroupRun`을 부른다. 이미 끝난 기록이 있으면 그룹도 `waitForEvent`도 부르지 않고 결과 step으로 간다.
- 그룹이 실패를 알리면 회차는 `failed`이고 `error`가 그 문구다.
- `waitForEvent`가 던지고(제한 시간) 기록이 `running`이면 기록이 `did not finish within 60 minutes`로 닫히고 회차는 `failed`다.
- `waitForEvent`가 던졌지만 기록이 이미 `completed`면 다음 단계로 간다.
- 결과 step에서 기록이 없으면 `stage run record was removed`로 실패한다.
- `finish-run`이 결과와 관계없이 진행 중인 단계 실행 기록을 닫는다.
- 수동 실행 인자(`runID`): `pending` 기록이 `running`이 되고 단계가 실행된다. 기록이 없으면 `cancelled`, 이미 끝났으면 `finished`다. 꺼진 스케줄도 실행한다.

**수동 실행.** 새 테스트 파일에서 `handleExecuteScheduler`를 직접 부른다.

- 크롤러 단계만 있으면: 응답이 지금과 같고(`200`, 실행 결과 본문), 단계 목록을 한 번만 읽으며, 인스턴스를 만들지 않는다.
- 단계 목록 읽기가 실패하면 실행 기록에 그 실패가 남고 지금과 같은 응답이 온다.
- 그룹 단계가 있으면 `202`, 본문의 `status`가 `pending`, 인스턴스가 ID `manual-<실행 ID>`와 인자 `{ schedulerID, runID }`로 만들어진다. 요청 안에서 단계를 실행하지 않는다.
- 인스턴스 만들기가 던지면 실행 기록이 `failed`가 된다.
- 진행 중인 실행이 있으면 `409`다.

**실행 기록.** `GET …/runs/:runID` 응답에 `stage_runs`가 `stage_order` 순서로 있고, `progress`가 들어 있으며, `input`·`output`은 없다.

**tick.** 그룹 단계가 있는 수동 실행 기록(인스턴스 `manual-<실행 ID>`가 `waiting`)은 10분이 지나도 닫지 않는다. 인스턴스가 없는 수동 기록은 지금처럼 닫는다.

**entrypoint.** 테스트 환경에서 `cloudflare:workers`의 `exports.TaskGroupReports`로 RPC 호출이 닿는지 한 번 확인한다. `SchedulerRunWorkflow`가 환경의 binding을 그룹 워커로 넘기는지도 클래스를 직접 만들어 확인한다.

**웹.** `StageCard`가 그룹 단계를 `Task group newscast v1`로 보여 주고 죽지 않는다. 크롤러 단계는 지금과 같다.

## 10. 배포와 그룹 붙이기

- **배포 순서.** 마이그레이션을 워커보다 먼저 적용한다(05와 같다). 마이그레이션만 먼저 있어도 지금 워커는 그대로 동작한다. `wrangler.toml`의 설정과 배포 워크플로는 바꾸지 않는다(`wrangler.toml`은 Workflow 설명 주석 한 줄만 고친다). 이름 있는 entrypoint는 export만 하면 된다.
- **배포 뒤 달라지는 것.** 등록된 그룹이 없으므로 사용자가 보는 동작은 같다. `GET /task-groups`가 빈 목록을 주고, 실행 기록 응답에 `stage_runs`가 생긴다. 단계를 고칠 때 Supabase 조회가 한 번 늘어난다.
- **그룹을 붙일 때 할 일**(이번에는 하지 않는다).
  1. 그룹의 워커를 배포한다. 기본 entrypoint나 이름 있는 entrypoint에 `startTaskGroupRun`을 둔다. 그 워커의 `wrangler.toml`에 스케줄러의 알림 entrypoint를 건다.
     ```toml
     [[services]]
     binding = "SCHEDULER_TASK_GROUP_REPORTS"
     service = "audio-underview-scheduler-manager-worker"
     entrypoint = "TaskGroupReports"
     ```
  2. 스케줄러의 `wrangler.toml`에 그 워커의 binding을 더하고 스케줄러를 배포한다.
  3. `task_groups`에 행을 넣는다. `worker_binding`은 2의 binding 이름이다. 형식은 4절의 키워드만 쓴다.

  스케줄러가 이미 있으므로 1이 먼저 될 수 있고, 두 워커가 서로를 가리켜도 배포 순서가 막히지 않는다.

## 11. 이번에 하지 않는 것

- 실제 작업 그룹(뉴스캐스트)과 그 워커, 등록 행.
- 웹에서 그룹 단계를 만들고 고치는 화면, 진행 상황을 보여 주는 화면.
- 그룹을 등록하는 API. 등록은 행을 넣는 것이다.
- 그룹마다 다른 제한 시간.
- 그룹에 중단을 알리는 것. 제한 시간이 지나거나 실행이 닫히면 그룹은 다음 알림에서 `accepted: false`를 받는다.

| 항목 | 상태 | 원인 | 재접속 단계 |
| -- | -- | -- | -- |
| 등록된 작업 그룹 | 미접속 | 실제 그룹이 없음 | 뉴스캐스트 그룹 |
| 그룹 단계 편집 화면 | 미접속 | 웹은 크롤러 단계만 만든다 | 웹 편집 화면 |
| 진행 상황 표시 | 미접속 | API(`stage_runs[].progress`)에만 있음 | 웹 편집 화면 |

## 12. 확인한 외부 사실

2026-10-04에 공식 문서에서 확인했다.

- `step.waitForEvent`의 `type`은 영숫자·`-`·`_`, 100자 이하다. 제한 시간은 1초~365일이고 기본 24시간이며, 넘기면 던진다. 인스턴스가 만들어진 뒤라면 `waitForEvent`에 닿기 전에 보낸 이벤트도 보관됐다가 전달된다. ([Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/), [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/))
- step은 여러 번 실행될 수 있으므로 같은 결과를 내게 만들라고 한다. `step.do`의 제한 시간은 30분 이하로 하고, 더 길게 기다릴 때는 `waitForEvent`를 쓰라고 한다. ([Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/))
- `waiting` 상태의 인스턴스는 동시 실행 한도에 들지 않는다. ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/))
- 워커는 기본 export 말고도 이름 있는 `WorkerEntrypoint` 클래스를 여러 개 export할 수 있고, 다른 워커는 service binding의 `entrypoint`로 그중 하나를 가리킨다. 문서의 예는 기본 export도 클래스다. 이 워커처럼 기본 export가 객체인 경우는 문서에 따로 적혀 있지 않아 테스트에서 확인했다. 테스트 환경에서 `cloudflare:workers`의 `exports.TaskGroupReports`(자기 자신으로 가는 service binding)로 RPC 호출이 닿는다. 다른 워커에서 `[[services]]`로 거는 경우는 그룹을 붙일 때 처음 확인하게 된다. ([Service bindings RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/))
