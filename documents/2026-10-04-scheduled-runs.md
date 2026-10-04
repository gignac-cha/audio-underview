# 스케줄 자동 실행 설계

작성일 2026-10-04. 이 설계대로 `feature/scheduled-runs` 브랜치에 구현했다.

요구사항은 `documents/migration/05-scheduled-runs.md`에 있다. 지금 스케줄러는 cron 식을 저장만 하고 실행하지 않는다. 이 문서는 저장된 스케줄이 그 시각에 자동으로 실행되게 하는 방법을 정한다. 기준 코드는 `main`(`e11bdf6`)이고, 고치는 곳은 `packages/supabase-connector`, `workers/scheduler-manager-worker`, `applications/web` 세 곳이다.

## 1. 전체 흐름

1. 스케줄을 저장할 때 워커가 다음 실행 시각을 계산해 `schedulers.next_run_at`에 넣는다.
2. 워커의 cron trigger가 10분마다 한 번 돈다. 이 실행을 tick이라고 부른다.
3. tick은 `next_run_at`이 지난 스케줄을 찾아 스케줄마다 Cloudflare Workflow 인스턴스를 하나 만들고, `next_run_at`을 그다음 시각으로 옮긴다.
4. Workflow 인스턴스가 실행 기록을 만들고, stage를 순서대로 실행하고, 결과를 기록한다.

수동 실행(`POST /schedulers/:id/execute`)은 지금처럼 요청 안에서 바로 실행한다. 이 경로의 코드와 응답은 바꾸지 않는다.

## 2. 결정한 것과 이유

**다음 실행 시각을 DB에 저장한다.** tick마다 모든 스케줄의 cron 식을 해석하지 않고 `next_run_at <= 지금`인 행만 읽으면 된다. 놓친 회차를 다루기도 쉽다. 값이 지났으면 한 번 실행하고 지금 뒤의 첫 시각으로 옮기면 끝이다.

**같은 회차의 중복 실행은 두 곳에서 막는다.** 첫째, 인스턴스 ID를 "스케줄 ID + 회차 시각"으로 정한다. Workflows의 `createBatch`는 이미 있는 ID를 건너뛰므로 tick이 같은 회차로 두 번 불러도 인스턴스는 하나다. 둘째, 실행 기록에 `(scheduler_id, scheduled_for)` 고유 인덱스를 둔다. 인스턴스가 어떤 이유로 두 개 생겨도 기록은 하나만 만들어진다.

**이전 실행이 진행 중이면 건너뛴 기록을 남긴다.** 스케줄당 진행 중인 실행은 하나만 허용하는 인덱스(`scheduler_runs_one_active_per_scheduler`)가 이미 있다. 새 실행 기록을 만들다가 이 인덱스에 걸리면 그 회차를 `skipped` 상태로 기록한다.

**중단된 실행은 tick이 실패로 닫는다.** 실행이 도중에 죽으면 기록이 `running`으로 남고, 그러면 이후 회차가 모두 건너뛰어진다. 그래서 tick은 가장 먼저 10분 넘게 진행 중인 기록을 살펴, Workflow 인스턴스가 살아 있지 않은 것을 `failed`로 바꾼다.

**놓친 회차는 보충하지 않는다.** tick 한 번에 스케줄 하나는 회차 하나만 만든다. 워커가 한동안 멈췄다가 돌아와도 밀린 횟수만큼 몰아서 실행하지 않는다.

**cron 식의 분은 10분 단위만 쓴다.** tick이 10분마다 돌기 때문에 그 사이 시각은 정확히 지킬 수 없다. 새로 저장하는 식은 분이 10분 단위가 아니면 거절하고, 이미 저장된 식은 마이그레이션에서 10분 단위로 바꾼다(3절). 바꿀 때는 분을 10분 단위로 내린다. 올리면 `55 23 * * 1`처럼 시와 요일까지 바뀌기 때문이다. 대신 그런 스케줄은 전보다 최대 9분 일찍 실행된다.

**cron 해석은 직접 구현한다.** 외부 라이브러리를 넣지 않고, 이번 작업에서 새로 넣는 의존성은 없다. 해석하는 문법은 지금 저장 검증(`isValidCronExpression`)이 받는 문법과 같다. 시간대 변환은 런타임의 `Intl.DateTimeFormat`으로 한다(4절).

**stage 하나를 실행하는 코드를 함수로 뽑는다.** 지금은 `executeScheduler`의 반복문 안에 있다. 이 본문을 `executePipelineStage`로 옮겨 수동 실행과 Workflow가 같이 쓴다. 수동 실행의 동작은 그대로이고, 기존 테스트 세 개(`scheduler-executor`, `stage-runner`, `scheduler-execution`)는 고치지 않고 통과해야 한다.

## 3. 데이터

마이그레이션 `packages/supabase-connector/migrations/011_add_scheduled_runs.sql`:

```sql
-- Migration: Scheduled runs
-- A scheduler with a cron expression runs on its own. This adds what a
-- scheduler needs to know when it runs next, and what a run records about the
-- occurrence it belongs to.

-- A scheduled occurrence that cannot start because the previous run is still
-- in progress is recorded with this status. The value is not used elsewhere in
-- this file: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE scheduler_run_status ADD VALUE IF NOT EXISTS 'skipped';

ALTER TABLE schedulers
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  ADD COLUMN next_run_at TIMESTAMPTZ;

COMMENT ON COLUMN schedulers.timezone IS 'IANA time zone the cron expression is evaluated in';
COMMENT ON COLUMN schedulers.next_run_at IS 'Next scheduled occurrence; NULL when the scheduler is disabled or has no cron expression';

-- Schedulers run on a 10-minute tick, so a stored cron expression must only
-- name minutes 0, 10, 20, 30, 40 or 50. Each minute an existing minute field
-- names is rounded down to a multiple of 10, and the field is rewritten as the
-- sorted list of those minutes: '5 9 * * *' becomes '0 9 * * *' and
-- '*/15 * * * *' becomes '0,10,30,40 * * * *'. Rounding down never changes
-- the hour or the day; such a scheduler runs up to 9 minutes earlier.
CREATE FUNCTION pg_temp.round_schedule_minutes(minute_field TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  minutes INTEGER[] := ARRAY[]::INTEGER[];
  part TEXT;
BEGIN
  -- A step of 60 or more names the first minute only, so steps are capped at
  -- 60 before the cast; the save check allows steps with any number of digits.
  IF minute_field ~ '^\*(/[1-9][0-9]*)?$' THEN
    minutes := ARRAY(SELECT generate_series(0, 59, LEAST(COALESCE(substring(minute_field FROM '/([0-9]+)$')::NUMERIC, 1), 60)::INTEGER));
  ELSIF minute_field ~ '^[0-9]{1,2}/[1-9][0-9]*$' THEN
    minutes := ARRAY(SELECT generate_series(split_part(minute_field, '/', 1)::INTEGER, 59, LEAST(split_part(minute_field, '/', 2)::NUMERIC, 60)::INTEGER));
  ELSIF minute_field ~ '^[0-9]{1,2}(-[0-9]{1,2})?(,[0-9]{1,2}(-[0-9]{1,2})?)*$' THEN
    FOREACH part IN ARRAY string_to_array(minute_field, ',') LOOP
      minutes := minutes || ARRAY(SELECT generate_series(
        split_part(part, '-', 1)::INTEGER,
        COALESCE(NULLIF(split_part(part, '-', 2), '')::INTEGER, split_part(part, '-', 1)::INTEGER)
      ));
    END LOOP;
  ELSE
    RETURN NULL;
  END IF;

  IF cardinality(minutes) = 0 OR 59 < ANY (minutes) THEN
    RETURN NULL;
  END IF;

  RETURN (
    SELECT string_agg(rounded_minute::TEXT, ',' ORDER BY rounded_minute)
    FROM (SELECT DISTINCT (minute / 10) * 10 AS rounded_minute FROM unnest(minutes) AS minute) AS rounded_minutes
  );
END;
$$;

WITH split_expressions AS (
  SELECT
    id,
    substring(btrim(cron_expression, E' \t\n\r') FROM '^(\S+)') AS minute_field,
    substring(btrim(cron_expression, E' \t\n\r') FROM '^\S+(\s.*)$') AS remaining_fields
  FROM schedulers
  WHERE cron_expression IS NOT NULL
),
rounded_expressions AS (
  SELECT id, pg_temp.round_schedule_minutes(minute_field) || remaining_fields AS cron_expression
  FROM split_expressions
  WHERE minute_field !~ '^(\*/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$'
)
UPDATE schedulers
SET cron_expression = rounded_expressions.cron_expression
FROM rounded_expressions
WHERE schedulers.id = rounded_expressions.id
  AND rounded_expressions.cron_expression IS NOT NULL;

DROP FUNCTION pg_temp.round_schedule_minutes(TEXT);

CREATE INDEX schedulers_next_run_at_index
  ON schedulers (next_run_at)
  WHERE next_run_at IS NOT NULL;

ALTER TABLE scheduler_runs
  ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN scheduled_for TIMESTAMPTZ,
  ADD CONSTRAINT scheduler_runs_triggered_by_check
    CHECK (triggered_by IN ('manual', 'schedule')),
  ADD CONSTRAINT scheduler_runs_scheduled_for_check
    CHECK ((triggered_by = 'schedule') = (scheduled_for IS NOT NULL));

COMMENT ON COLUMN scheduler_runs.triggered_by IS 'What started the run: manual (API call) or schedule (cron occurrence)';
COMMENT ON COLUMN scheduler_runs.scheduled_for IS 'The cron occurrence a scheduled run belongs to; NULL for manual runs';

-- One run per scheduled occurrence, so a repeated trigger cannot run it twice.
CREATE UNIQUE INDEX scheduler_runs_scheduled_occurrence_unique_index
  ON scheduler_runs (scheduler_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;

-- The 10-minute tick moves next_run_at for many schedulers and closes many
-- interrupted runs. One request per row would exceed the Workers Free limit of
-- 50 external requests per invocation, so each kind of change is one call.

-- Moves next_run_at for many schedulers. Each element of updates is
-- {"id": uuid, "expected_next_run_at": timestamptz or null,
--  "next_run_at": timestamptz or null}. A scheduler changes only while its
-- next_run_at is still the expected value, so one a user edited in the
-- meantime is left alone. Returns the IDs that changed.
CREATE FUNCTION set_scheduler_next_runs(updates JSONB)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.schedulers
  SET next_run_at = requested.next_run_at
  FROM jsonb_to_recordset(updates) AS requested(id UUID, expected_next_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ)
  WHERE schedulers.id = requested.id
    AND schedulers.next_run_at IS NOT DISTINCT FROM requested.expected_next_run_at
  RETURNING schedulers.id;
$$;

-- Closes many interrupted runs. Only runs still pending or running change, so
-- a run that finished in the meantime keeps its result. Returns the IDs that
-- changed.
CREATE FUNCTION fail_scheduler_runs(run_ids UUID[], failed_at TIMESTAMPTZ, failure_message TEXT)
RETURNS SETOF UUID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.scheduler_runs
  SET status = 'failed', completed_at = failed_at, error = failure_message
  WHERE id = ANY(run_ids)
    AND status IN ('pending', 'running')
  RETURNING id;
$$;

-- Only the service role (the workers) may call these functions. The public
-- anon and authenticated keys must not change scheduling data. The roles exist
-- on Supabase only, hence the check.
REVOKE EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) FROM anon, authenticated;
    GRANT EXECUTE ON FUNCTION set_scheduler_next_runs(JSONB) TO service_role;
    GRANT EXECUTE ON FUNCTION fail_scheduler_runs(UUID[], TIMESTAMPTZ, TEXT) TO service_role;
  END IF;
END;
$$;
```

| 컬럼 | 뜻 |
| -- | -- |
| `schedulers.timezone` | cron 식을 해석할 시간대. 기본값 `Asia/Seoul` |
| `schedulers.next_run_at` | 다음 실행 시각. 스케줄이 꺼져 있거나 cron 식이 없으면 NULL |
| `scheduler_runs.triggered_by` | `manual`(수동 실행) 또는 `schedule`(예약 실행) |
| `scheduler_runs.scheduled_for` | 예약 실행이 속한 회차의 예정 시각. 수동 실행은 NULL |
| 상태 `skipped` | 이전 실행이 진행 중이라 실행하지 않은 회차 |

새 컬럼은 모두 기본값이 있거나 NULL을 허용한다. 그래서 이 마이그레이션은 지금 배포된 워커와 함께 있어도 문제가 없다.

마이그레이션은 이미 저장된 cron 식의 분 필드도 10분 단위로 바꾼다. 켜져 있든 꺼져 있든 모든 스케줄이 대상이다. 분 필드가 가리키는 분을 하나씩 10분 단위로 내리고, 중복을 없앤 뒤 오름차순 목록으로 다시 쓴다. 시·일·월·요일 필드는 그대로 둔다.

| 지금 | 바꾼 뒤 |
| -- | -- |
| `0 9 * * *`, `*/20 * * * *` 등 이미 10분 단위 | 그대로 |
| `5 9 * * *` | `0 9 * * *` |
| `59 23 * * 1` | `50 23 * * 1` |
| `0,15,45 9 * * *` | `0,10,40 9 * * *` |
| `*/15 * * * *` | `0,10,30,40 * * * *` |
| `* * * * *`, `*/5 * * * *` | `0,10,20,30,40,50 * * * *` |
| `0-30 9 * * *` | `0,10,20,30 9 * * *` |
| 해석할 수 없는 식(`not a cron`, `60 9 * * *`) | 그대로. 다음 실행 시각을 구할 수 없어 실행되지 않는다 |

앞뒤의 공백·탭·줄바꿈은 지우고 본다. 간격이 60 이상이면 첫 분만 가리키므로 60으로 줄여 계산한다. 저장 검증은 간격의 자릿수를 제한하지 않아서(`*/99999999999`), 그대로 정수로 바꾸면 마이그레이션 전체가 실패하기 때문이다.

이 표의 사례를 포함한 32개 사례(아주 큰 간격, 탭으로 시작하는 식 포함)를 PGlite(Postgres 17)에서 마이그레이션 001~011을 차례로 적용해 확인했다.

connector에는 타입(`SchedulerRunTrigger`, 새 컬럼, `'skipped'`)과 조회·갱신 함수 여덟 개를 더한다. 기존 함수처럼 `traceDatabaseOperation`으로 감싸고 오류면 `Failed to …`를 던진다.

여러 행을 바꾸는 두 함수(`setSchedulerNextRuns`, `failSchedulerRuns`)는 마이그레이션 011이 만드는 Postgres 함수를 RPC로 한 번 부른다. 두 Postgres 함수는 `service_role`만 실행할 수 있고, `PUBLIC`·`anon`·`authenticated`에서는 실행 권한을 거둔다. Supabase 공개 키로 데이터를 바꾸지 못하게 하기 위해서다.

| 함수 | 하는 일 |
| -- | -- |
| `getSchedulerByID(client, id)` | 사용자 조건 없이 `id`로 한 행을 읽는다. Workflow에는 사용자 정보가 없어서 필요하다 |
| `listSchedulersDue(client, now, limit)` | 켜져 있고, cron 식이 있고, `next_run_at <= now`인 행. `next_run_at` 오름차순 |
| `listSchedulersWithoutNextRun(client, limit, after?)` | 켜져 있고 cron 식이 있는데 `next_run_at`이 NULL인 행. `created_at`, `id` 오름차순. `after`(`{ created_at, id }`)를 주면 그 행 뒤부터 |
| `setSchedulerNextRuns(client, updates)` | `updates`(`{ id, expected, next }` 목록)를 Postgres 함수 `set_scheduler_next_runs` 한 번으로 보낸다. 행마다 `next_run_at`이 `expected`와 같을 때만(`null`이면 NULL일 때만) `next`로 바꾼다. 바뀐 행의 `id` 목록을 돌려준다. 그 사이에 사용자가 스케줄을 고쳤으면 덮어쓰지 않는다. `updates`가 비면 요청하지 않는다 |
| `failSchedulerRuns(client, runIDs, failedAt, failureMessage)` | Postgres 함수 `fail_scheduler_runs` 한 번으로, 아직 `pending`·`running`인 실행만 `failed`로 닫는다. 바뀐 행의 `id` 목록을 돌려준다. `runIDs`가 비면 요청하지 않는다 |
| `getSchedulerRunByOccurrence(client, schedulerID, scheduledFor)` | 그 회차의 실행 기록 한 행 |
| `listActiveSchedulerRunsBefore(client, createdBefore, limit)` | `pending`·`running`이면서 `created_at < createdBefore`인 기록. `created_at` 오름차순 |
| `getSchedulerStageRun(client, id, runID)` | stage 실행 기록 한 행 |

## 4. 다음 실행 시각

워커에 `sources/schedule.ts`를 새로 만든다.

```ts
export const DEFAULT_TIMEZONE = 'Asia/Seoul';

export function isScheduleMinuteAllowed(cronExpression: string): boolean
export function isValidTimezone(timezone: string): boolean
export function computeNextRunAt(cronExpression: string, timezone: string, after: Date): Date | null
export function resolveNextRunAt(
  scheduler: Pick<SchedulerRow, 'cron_expression' | 'timezone' | 'is_enabled'>,
  after: Date,
): string | null
export function schedulerRunInstanceID(schedulerID: string, scheduledFor: Date): string
```

- `isScheduleMinuteAllowed`는 cron 식의 첫 필드(분)가 `/^(\*\/(10|20|30)|(0|10|20|30|40|50)(,(0|10|20|30|40|50))*)$/`에 맞는지 본다. `0`, `30`, `0,30`, `*/10`, `*/20`, `*/30` 같은 값만 통과한다.
- `isValidTimezone`은 형식(`/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/`)을 보고, `Intl.DateTimeFormat`이 그 시간대를 받는지 확인한다.
- `computeNextRunAt`은 `after`보다 뒤인 첫 실행 시각을 돌려준다. 그런 시각이 없거나 식·시간대를 해석하지 못하면 `null`이다. 던지지 않는다. 시간대가 `isValidTimezone`을 통과하지 못하면 `null`이고, 아니면 `parseCronExpression`과 `findNextOccurrence`(아래)를 `try`로 감싸 부른다.
- `resolveNextRunAt`은 스케줄이 꺼져 있거나 cron 식이 없으면 `null`, 아니면 `computeNextRunAt` 결과의 ISO 문자열이다.
- `schedulerRunInstanceID`는 `` `${schedulerID}-${Math.floor(scheduledFor.getTime() / 60000)}` ``다. UUID 뒤에 분 단위 epoch가 붙어 45자쯤이고, Workflows의 ID 규칙(영숫자·`-`·`_`, 100자 이하)에 맞는다.

### cron 식 해석과 다음 시각 탐색

`sources/cron-expression.ts`를 새로 만든다.

```ts
export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>; // 0 = Sunday … 6 = Saturday
  dayOfMonthStarred: boolean;
  dayOfWeekStarred: boolean;
}

export function parseCronExpression(expression: string): CronSchedule | null
export function findNextOccurrence(schedule: CronSchedule, timezone: string, after: Date): Date | null
```

**해석.** 앞뒤 공백을 지우고 공백으로 나눠 필드가 정확히 다섯 개여야 한다. 범위는 분 0–59, 시 0–23, 일 1–31, 월 1–12, 요일 0–7이다. 요일 7은 0(일요일)으로 바꾼다. 필드 하나는 아래 형식 중 하나다. 지금 저장 검증이 받는 형식과 같다.

| 형식 | 뜻 | 예(분) |
| -- | -- | -- |
| `*` | 범위 전체 | 0–59 |
| `*/s` | 범위의 처음부터 s 간격 | `*/20` → 0, 20, 40 |
| `n` | 그 값 | `30` → 30 |
| `n/s` | n부터 범위 끝까지 s 간격 | `5/10` → 5, 15, 25, 35, 45, 55 |
| `n` 또는 `n-m`을 쉼표로 이은 목록 | 그 값들. `n-m`은 n부터 m까지 | `0,30`, `1-5`, `1-5,10` |

간격 s는 1 이상이다. 범위를 벗어난 값, `n > m`인 범위, 그 밖의 문자(`MON` 같은 이름, `?`, `L`, `W`, `#`, `1-5/2`)는 해석하지 못한 것으로 보고 `null`을 돌려준다.

`dayOfMonthStarred`와 `dayOfWeekStarred`는 각 필드가 `*`로 시작하는지다(`*`, `*/s`).

**일과 요일 규칙.** 표준 cron과 같다. 일 필드나 요일 필드 중 하나라도 `*`로 시작하면 두 조건을 모두 만족해야 하고, 둘 다 `*`로 시작하지 않으면 둘 중 하나만 만족하면 된다. 예를 들어 `0 9 6 * 0`은 "6일 또는 일요일 9시"이고, `0 9 */2 * 1`은 "홀수 날이면서 월요일 9시"다.

**탐색.** 시간대의 날짜·시각은 `Intl.DateTimeFormat`의 `formatToParts`로 읽는다. 옵션은 `timeZone`, `hourCycle: 'h23'`, `weekday: 'short'`이고 `year`·`month`·`day`·`hour`·`minute`은 `'numeric'`이다. 포매터는 `findNextOccurrence` 호출마다 한 번만 만든다.

1. 후보 시각 t는 `after`보다 뒤인 첫 UTC 정각 분이다.
2. t가 `after`로부터 9년을 넘거나 반복이 100,000번을 넘으면 `null`을 돌려준다. 2월 29일만 지정한 식은 최대 8년(2096년 → 2104년) 뒤에 오므로 9년이면 충분하다.
3. t의 현지 날짜·시각을 읽고 아래 순서로 본다. 여유는 120분이다.
   - 월이 맞지 않으면 다음 달 1일 0시 근처로 건너뛴다: (현지 자정까지 남은 분) + (이달에 남은 날 수 × 1,440) − 120분.
   - 날짜가 맞지 않으면 자정 근처로 건너뛴다: (현지 자정까지 남은 분) − 120분.
   - 위 두 경우에 건너뛸 분이 1보다 작으면, 즉 이미 자정까지 120분이 안 남았으면 다음 현지 정시로 건너뛴다(아래 "다음 현지 정시").
   - 시가 맞지 않으면 다음 현지 정시로 건너뛴다.
   - 분이 맞지 않으면 그 시간 안에서 다음으로 허용된 분으로 건너뛴다. 없으면 다음 현지 정시로 건너뛴다.
   - 모두 맞으면 t를 돌려준다. 단, 같은 현지 시각이 30분, 60분, 120분 전 중 한 번이라도 있었으면(시계가 뒤로 간 경우) 1분 뒤로 가서 계속한다.

**다음 현지 정시.** (60 − 현지 분)만큼 건너뛴 뒤 그곳의 현지 시각을 읽는다. 현지 시각이 다음 정시를 넘었으면 그 사이에 시계가 앞으로 간 것이다. 이때는 건너뛰기 전과 후 사이를 이분 탐색해, 현지 시각이 다음 정시 이상이 되는 첫 분을 돌려준다. 시계가 정시가 아닌 시각에 바뀌는 시간대가 있어서 필요하다. 예를 들어 `Pacific/Chatham`은 02:45에서 03:45로 바뀌므로, 02:00에서 60분을 건너뛰면 04:00에 떨어져 실제로 있는 03:45~03:59를 지나친다. 시계가 뒤로 간 경우는 두 번 오는 시각만 건너뛰므로 그대로 둔다. 건너뛴 자리의 현지 시각은 다음 반복에서 다시 쓰므로, 시계 변경이 없으면 읽는 횟수가 늘지 않는다.

건너뛸 때 120분을 빼는 이유는 일광 절약 시간으로 하루가 22~23시간인 날에도 다음 날의 이른 시각을 넘어가지 않게 하기 위해서다. 시계가 2시간 바뀌는 시간대(남극 Troll 기지)까지 막으려면 120분이 필요하다. 자정 전 마지막 구간은 위의 다음 현지 정시로 건너뛴다.

탐색 비용은 건너뛰는 날 하루마다 현지 시각 읽기 서너 번이다. 매월 1일 식은 백 번 남짓, 영영 오지 않는 식(`0 0 31 2 *`)도 9년치를 수천 번이면 다 본다. 저장 요청과 tick이 이 계산을 하므로, 영영 오지 않는 식도 몇 밀리초 안에 끝나야 한다.

**일광 절약 시간.** 기본 시간대 `Asia/Seoul`에는 일광 절약 시간이 없다. 다른 시간대를 쓰면 이렇게 된다.

- 시계가 앞으로 가서 없는 현지 시각(예: 미국 동부 3월의 02:30)은 그날 실행하지 않는다.
- 시계가 뒤로 가서 두 번 오는 현지 시각(예: 미국 동부 11월의 01:30)은 처음 한 번만 실행한다.
- 시계가 2시간 바뀌는 시간대(`Antarctica/Troll`)와 정시가 아닌 시각에 바뀌는 시간대(`Pacific/Chatham`)도 같은 규칙을 따른다.

## 5. 스케줄 저장

`POST /schedulers`와 `PUT /schedulers/:id`가 `timezone`(선택, 문자열)을 받는다. 기존 검증 뒤에 아래 검사를 더한다. 모두 `400 invalid_request`다.

| 조건 | `error_description` |
| -- | -- |
| `timezone`이 있는데 문자열이 아님(`PUT`의 `null` 포함) | `Field 'timezone' must be a string` |
| 유효한 시간대가 아님 | `Field 'timezone' must be a valid IANA time zone` |
| cron 식의 분이 10분 단위가 아님 | `Field 'cron_expression' minute must be 0, 10, 20, 30, 40 or 50` |
| 저장될 시간대로 다음 실행 시각을 구할 수 없음 | `Field 'cron_expression' must be a valid cron expression` |

아래 두 검사는 요청에 cron 식이 문자열로 있을 때만 한다.

**만들 때**는 `timezone`에 요청 값 또는 `Asia/Seoul`을, `next_run_at`에 `resolveNextRunAt` 결과를 저장한다.

**고칠 때** 요청에 `cron_expression`, `timezone`, `is_enabled` 중 하나라도 있으면 지금 행을 먼저 읽는다. 없으면 지금과 같은 404다. 요청 값을 지금 행에 덮어쓴 값으로 `next_run_at`을 다시 계산해 함께 저장한다. 스케줄을 끄거나 cron 식을 지우면 `next_run_at`이 NULL이 되어 자동 실행이 멈춘다. 이름만 바꾸는 요청은 지금 행을 읽지 않고 `next_run_at`도 건드리지 않는다. 요청 본문의 `next_run_at`은 무시한다.

## 6. 10분 tick

`wrangler.toml`에 cron trigger를 추가하고, 워커의 default export에 `scheduled` 핸들러를 추가한다. 핸들러는 `runScheduleTick`을 부르고 결과를 로그로 남긴다. 오류는 로그로 남기고 다시 던진다.

```toml
[triggers]
crons = ["*/10 * * * *"]
```

```ts
// sources/schedule-tick.ts
export interface ScheduleTickDependencies {
  supabaseClient: SupabaseClient;
  workflow: Pick<Workflow, 'createBatch' | 'get'>;
  logger: Logger;
}
export interface ScheduleTickResult { interrupted: number; initialized: number; started: number }

export async function runScheduleTick(dependencies: ScheduleTickDependencies, now: Date): Promise<ScheduleTickResult>
```

`now`는 trigger의 예정 시각(`controller.scheduledTime`)이다. tick은 세 단계를 이 순서로 한다.

**1단계, 중단된 실행 정리.** `listActiveSchedulerRunsBefore`로 만든 지 10분이 넘은 진행 중 기록을 200개까지 읽는다.

- 예약 실행 기록이면 그 회차의 인스턴스 상태를 `workflow.get(...).status()`로 본다. 상태가 `queued`·`running`·`paused`·`waiting`·`waitingForPause`·`unknown`이면 아직 살아 있는 것이므로 그대로 둔다. `get`이 던지면 인스턴스가 없는 것으로 본다. `status()`가 던지면 상태를 알 수 없으므로 `unknown`과 같이 그 기록을 그대로 두고, 경고 로그를 남긴 뒤 다음 기록으로 넘어간다. 상태 조회 하나가 실패했다고 tick 전체가 멈추지 않는다.
- 그 밖의 기록은 `status: 'failed'`, `error: 'Run was interrupted'`로 닫는다. 수동 실행 기록, 인스턴스가 없는 기록, 인스턴스가 `errored`·`terminated`·`complete`인 기록이 여기에 든다. 닫을 기록을 모두 모은 뒤 `failSchedulerRuns` 한 번으로 보낸다. 그 사이에 끝난 기록은 함수가 건드리지 않는다.

수동 실행은 5분 제한이 있다. 10분 뒤에도 진행 중인 수동 기록은 중단된 것이다.

**2단계, 초기화.** `listSchedulersWithoutNextRun`으로 읽은 행마다 다음 실행 시각을 계산하고, 한 페이지에서 계산된 값을 모아 `setSchedulerNextRuns`(`expected: null`) 한 번으로 넣는다. 마이그레이션 전에 저장된 스케줄이 여기서 처음 값을 받는다. 이 단계에서는 실행하지 않는다.

다음 실행 시각을 구할 수 없는 행(영영 오지 않거나 해석할 수 없는 기존 cron 식)은 값을 받지 못해 NULL로 남고, 다음 tick에도 다시 읽힌다. 이런 행이 앞쪽을 차지해도 뒤의 행이 초기화되도록, 한 페이지(500행)만 보지 않고 `created_at`, `id` 순서의 커서로 다음 페이지를 이어 읽는다. 한 tick에 최대 4페이지(2,000행)까지 본다. 구할 수 없는 행이 있으면 그 수를 경고 로그로 한 번 남긴다.

**3단계, 실행.** `listSchedulersDue`로 실행할 행을 500개까지 읽는다. 행마다 회차 시각은 그 행의 `next_run_at`이다. 인스턴스를 `{ id: schedulerRunInstanceID(...), params: { schedulerID, scheduledFor } }`로 만들어 100개씩 `createBatch`에 넘긴다. `createBatch`가 모두 끝난 뒤에 모든 행의 `next_run_at`을 `now` 뒤의 첫 시각으로 옮긴다. 옮기는 값은 한데 모아 `setSchedulerNextRuns`(`expected`: 그 행에서 읽은 `next_run_at`) 한 번으로 보낸다.

순서가 중요하다. `next_run_at`을 먼저 옮기고 `createBatch`가 실패하면 그 회차는 사라진다. 반대로 `createBatch` 뒤에 갱신이 실패하면 다음 tick이 같은 ID로 다시 부르고, 이미 있는 ID라서 건너뛴다.

**요청 수.** 운영 계정은 Workers Free라서 실행 한 번에 외부 요청(Supabase)이 50개까지다(Cloudflare 내부 서비스는 1,000개). 그래서 tick은 행마다 요청하지 않고 단계마다 묶어서 보낸다. tick 한 번의 Supabase 요청은 정리 2개(조회, 닫기), 초기화 페이지당 2개(조회, 갱신, 최대 4페이지), 실행 2개(조회, 갱신)로 많아야 12개이고, 스케줄 수와 관계없다. `createBatch`와 `workflow.get`은 Cloudflare 내부 서비스다.

## 7. 회차를 실행하는 Workflow

`wrangler.toml`에 Workflow를 추가하고 `Environment`에 `SCHEDULER_RUN_WORKFLOW: Workflow`를 추가한다.

```toml
[[workflows]]
name = "audio-underview-scheduler-run-workflow"
binding = "SCHEDULER_RUN_WORKFLOW"
class_name = "SchedulerRunWorkflow"
```

`sources/index.ts`가 `SchedulerRunWorkflow` 클래스를 export한다. 이 파일은 이 클래스와 타입 말고 다른 것을 이름으로 export하지 않는다. 상수나 함수를 export하면 Workers 런타임이 시작하지 못한다.

클래스(`sources/scheduler-run-workflow.ts`)는 환경에서 Supabase client와 크롤러 호출 client를 만들어 `runScheduledPipeline`을 부르기만 한다. 로직은 `sources/scheduled-pipeline.ts`에 두고 `step`을 인자로 받는다. 테스트에서 `step`을 fake로 바꿀 수 있게 하기 위해서다.

```ts
export interface SchedulerRunParameters { schedulerID: string; scheduledFor: string }

export interface ScheduledPipelineStep {
  do<T>(name: string, options: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}
export type ScheduledPipelineResult =
  | { outcome: 'cancelled' | 'skipped' | 'finished' }
  | { outcome: 'started'; runID: string; status: 'completed' | 'partially_failed' | 'failed' };

export async function runScheduledPipeline(
  dependencies: ExecutorDependencies,
  parameters: SchedulerRunParameters,
  step: ScheduledPipelineStep,
): Promise<ScheduledPipelineResult>
```

step은 네 종류다.

| step | 재시도·제한 시간 | 하는 일 |
| -- | -- | -- |
| `begin-run` | 5회, 1분 | 실행 기록을 만들거나, 건너뛰거나, 취소한다 |
| `load-stages` | 5회, 1분 | stage 목록을 읽는다 |
| `stage-<순서>` | 재시도 없음, 15분 | stage 하나를 실행한다 |
| `finish-run` | 5회, 1분 | 실행 기록을 닫고 `last_run_at`을 갱신한다 |

기록만 하는 step의 설정은 `{ retries: { limit: 5, delay: '3 seconds', backoff: 'exponential' }, timeout: '1 minute' }`이고, stage step은 `{ retries: { limit: 0, delay: 0 }, timeout: '15 minutes' }`다. stage는 크롤러를 실제로 부르므로 자동으로 다시 실행하지 않는다.

DB를 읽고 쓰는 일과 크롤러 호출은 모두 step 안에서 한다. step 반환값에는 stage의 출력을 넣지 않는다. step 반환값 상한이 1MiB이기 때문이다. 다음 step은 앞 step이 돌려준 `stageRunID`로 DB에서 출력을 읽는다.

**`begin-run`**

1. 스케줄을 읽는다. 없거나, 꺼져 있거나, cron 식이 없으면 `cancelled`로 끝낸다.
2. 이 회차의 실행 기록이 이미 있는지 본다. 있으면 아래 "이미 있는 기록"대로 한다.
3. 실행 기록을 만든다: `status: 'running'`, `started_at`, `triggered_by: 'schedule'`, `scheduled_for`.
4. 만들기가 실패하면 2를 다시 한다. 기록이 없고 오류가 `scheduler_runs_one_active_per_scheduler` 때문이 아니면 그 오류를 던진다.
5. 진행 중인 실행 때문에 실패한 것이면 건너뛴 기록을 만든다: `status: 'skipped'`, `triggered_by: 'schedule'`, `scheduled_for`, `completed_at`, `error: 'A previous run was still in progress'`. 이것도 실패하면 2를 다시 하고, 기록이 없으면 던진다.

이미 있는 기록이 `pending`·`running`이면 그 기록으로 이어서 실행한다. `skipped`면 `skipped`로, 그 밖이면 `finished`로 끝낸다. step이 재시도되거나 인스턴스가 다시 시작해도 기록이 두 개 생기지 않는다.

**`stage-<순서>`**

첫 stage의 입력은 `resolveDefaultInput(stage.input_schema)`이고, 그다음부터는 앞 stage 실행 기록의 `output`이다. `executePipelineStage`로 실행하고 `{ status, stageRunID }`를 돌려준다. 오류가 나면 `{ status: 'failed', error }`를 돌려주고, 남은 stage는 실행하지 않는다. 제한 시간을 넘겨 step 자체가 던진 오류도 실패로 처리한다.

**`finish-run`**

`begin-run`이 실행을 시작했으면 항상 실행한다. 실패가 있으면 `failed`, 일부 실패한 stage가 있으면 `partially_failed`, 아니면 `completed`다. 실패면 `error`를, 아니면 마지막 stage의 출력을 `result`로 저장한다. stage가 없으면 `completed`이고 `result`는 `null`이다. 기록 갱신에는 `onlyIfStatus: ['pending', 'running']` 조건을 건다.

**`executePipelineStage`**

```ts
export interface PipelineStageResult { stageRunID: string; output: unknown; partiallyFailed: boolean }

export async function executePipelineStage(
  dependencies: ExecutorDependencies,
  runID: string,
  stage: SchedulerStageRow,
  input: unknown,
  signal?: AbortSignal,
): Promise<PipelineStageResult>
```

`executeScheduler` 반복문의 본문(fan-out 분기와 일반 분기)을 그대로 옮긴 것이다. 던지는 오류와 메시지, DB에 쓰는 값이 지금과 같다.

## 8. 웹

- **실행 시각 입력.** cron 입력은 지금처럼 글자 입력이다. 생성 대화상자의 입력 아래에 `Runs at minute 0, 10, 20, 30, 40 or 50 · Asia/Seoul time`을 안내한다. 생성할 때와 상세 화면에서 cron을 고칠 때, 분이 10분 단위가 아니면 서버에 보내지 않고 toast(`Cron minute must be 0, 10, 20, 30, 40 or 50.`)로 알린다. 검사 규칙은 워커와 같은 정규식이고, 웹에 `schedule-minute.ts`로 따로 둔다. 두 workspace가 같이 쓰는 패키지가 없어서다.
- **스케줄 화면.** `Enabled`와 `Last Run` 사이에 `Timezone`과 `Next Run`을 보여 준다. 다음 실행 시각이 없으면 `Not scheduled`다.
- **실행 기록.** `Skipped` 배지를 추가한다. `Started` 칸은 시작 시각이 없으면 예정 시각(`scheduled_for`)을 보여 준다. 건너뛴 회차가 언제 것인지 알 수 있다.

## 9. 테스트

Workflow 인스턴스를 실제로 만드는 테스트는 쓰지 않는다. `@cloudflare/vitest-pool-workers`에서 격리 저장소 오류로 실패하기 때문이다. `workflow`와 `step`은 fake를 넣고, Supabase는 기존 테스트 방식대로 흉내 낸다.

**connector.** 함수마다 조회 조건, 행이 있을 때와 없을 때의 반환, 오류일 때 던지는 것을 확인한다. `setSchedulerNextRuns`와 `failSchedulerRuns`는 RPC 이름과 인자, 돌려받은 `id` 목록, 빈 목록이면 요청하지 않는 것을 확인한다.

**마이그레이션 함수.** PGlite에서 `set_scheduler_next_runs`가 `expected`와 같은 행만 바꾸는지(`null`은 NULL과만 같다), 다른 값으로 바뀐 행은 그대로 두는지, `fail_scheduler_runs`가 `pending`·`running`만 닫고 끝난 기록은 두는지 확인한다.

**cron 식 해석.** `parseCronExpression`이 형식마다 맞는 값 집합을 만든다: `*/20` → 0, 20, 40, `5/10` → 5, 15, …, 55, `1-5,10`, 요일 `7` → 0. `*`와 `*/s`로 시작하는 일·요일 필드는 `Starred`가 `true`다. 아래는 `null`이다: `60 * * * *`, `* 24 * * *`, `* * 0 * *`, `* * * 13 *`, `* * * * 8`, `5-1 * * * *`, `*/0 * * * *`, `1-5/2 * * * *`, `0 9 * * MON`, 필드 네 개, 필드 여섯 개, 빈 문자열.

**다음 실행 시각.** 아래 값은 손으로 계산했다. 구현이 다른 값을 내면 기대값을 맞추지 말고 원인을 확인한다. 2026-10-05는 월요일이다.

| cron | 시간대 | `after` | 결과 |
| -- | -- | -- | -- |
| `0 7 * * *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-05T22:00:00.000Z` |
| `0 7 * * *` | `Asia/Seoul` | `2026-10-04T21:59:59.999Z` | `2026-10-04T22:00:00.000Z` |
| `0 7 * * *` | `Asia/Seoul` | `2026-10-04T22:00:00.000Z` | `2026-10-05T22:00:00.000Z` |
| `0 7 * * *` | `UTC` | `2026-10-05T00:00:00.000Z` | `2026-10-05T07:00:00.000Z` |
| `*/10 * * * *` | `Asia/Seoul` | `2026-10-05T00:03:00.000Z` | `2026-10-05T00:10:00.000Z` |
| `0,30 9 * * 1-5` | `Asia/Seoul` | `2026-10-02T09:00:00.000Z` | `2026-10-05T00:00:00.000Z` |
| `0 9 * * 7` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-11T00:00:00.000Z` |
| `5 9 * * *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-05T00:05:00.000Z` |
| `5/10 * * * *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-05T00:05:00.000Z` |
| `0 9 1 * *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-11-01T00:00:00.000Z` |
| `0 9 6 * 0` (6일 또는 일요일) | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-06T00:00:00.000Z` |
| `0 9 */2 * 1` (홀수 날이면서 월요일) | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2026-10-19T00:00:00.000Z` |
| `0 0 29 2 *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `2028-02-28T15:00:00.000Z` |
| `30 2 * * *` (없는 시각) | `America/New_York` | `2027-03-13T12:00:00.000Z` | `2027-03-15T06:30:00.000Z` |
| `30 1 * * *` (두 번 오는 시각) | `America/New_York` | `2026-11-01T05:00:00.000Z` | `2026-11-01T05:30:00.000Z` |
| `30 1 * * *` (두 번 오는 시각) | `America/New_York` | `2026-11-01T05:30:00.000Z` | `2026-11-02T06:30:00.000Z` |
| `30 0 * * 1` (하루가 22시간인 날 다음) | `Antarctica/Troll` | `2027-03-27T12:00:00.000Z` | `2027-03-28T22:30:00.000Z` |
| `30 2 * * *` (2시간 되돌아가 두 번 오는 시각) | `Antarctica/Troll` | `2027-10-31T01:00:00.000Z` | `2027-11-01T02:30:00.000Z` |
| `50 3 * * *` (02:45에 바뀐 직후 있는 시각) | `Pacific/Chatham` | `2026-09-26T00:00:00.000Z` | `2026-09-26T14:05:00.000Z` |
| `0 3 * * *` (02:45에 바뀌어 없는 시각) | `Pacific/Chatham` | `2026-09-26T00:00:00.000Z` | `2026-09-27T13:15:00.000Z` |
| `0 0 31 2 *` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `null` |
| `not a cron` | `Asia/Seoul` | `2026-10-05T00:00:00.000Z` | `null` |
| `0 7 * * *` | `Not/AZone` | `2026-10-05T00:00:00.000Z` | `null` |

- 분 검사: `0 9 * * *`, `30 9 * * *`, `0,30 9 * * *`, `0,10,20,30,40,50 * * * *`, `*/10 * * * *`, `*/20 * * * *`, `*/30 * * * *`은 통과한다. `* * * * *`, `*/5 * * * *`, `*/15 * * * *`, `5 9 * * *`, `0,15 9 * * *`, `0-50 * * * *`, `0-50/10 * * * *`, `60 9 * * *`은 통과하지 못한다.
- 시간대 검사: `Asia/Seoul`, `UTC`, `America/New_York`은 통과한다. `Not/AZone`, `KST`, `+09:00`, 빈 문자열, 65자 문자열은 통과하지 못한다.
- 인스턴스 ID: 스케줄 `00000000-0000-0000-0000-000000000010`, 회차 `2026-10-05T22:00:00.000Z`이면 `00000000-0000-0000-0000-000000000010-29853960`이다.
- 문법 일치: 여러 필드 값을 만들어, `parseCronExpression`이 해석하는 식과 저장 검증(`isValidCronExpression`)이 받는 식이 같은지 확인한다.
- 탐색 비용: 현지 시각 읽기 횟수를 세어, `0 9 1 * *`가 200번, `0 0 29 2 *`가 1,000번, `0 0 31 2 *`(`null`)와 `0 0 31 2,4,6,9,11 *`(`null`)가 각각 10,000번을 넘지 않는지 확인한다. 시간이 아니라 횟수로 확인해 테스트가 기계 속도에 흔들리지 않게 한다.

**스케줄 저장.** 5절 표의 조건마다 400과 그 문구가 나온다. cron 식 `0 7 * * *`로 만들면 `timezone: 'Asia/Seoul'`과 `next_run_at`이 저장된다. cron 식이 없거나 꺼진 상태로 만들면 `next_run_at`은 `null`이다. 끄면 `next_run_at`이 `null`이 된다. 시간대만 바꾸면 지금 행의 cron 식으로 다시 계산한다. 이름만 바꾸면 지금 행을 읽지 않는다. 지금 행이 없으면 404다.

**tick.**
- 초기화: `next_run_at`이 없는 행이 `now` 뒤의 첫 시각을 받는다. cron 식을 해석하지 못하는 행은 건드리지 않는다.
- 초기화 페이지: 다음 실행 시각을 구할 수 없는 행 500개 뒤에 정상 행이 있어도, 같은 tick에서 정상 행이 초기화된다. 둘째 페이지는 첫 페이지 마지막 행의 `created_at`, `id` 뒤부터 읽는다. 4페이지를 넘게 읽지 않는다.
- 상태 조회 실패: 인스턴스의 `status()`가 던지면 그 기록은 그대로 두고, 같은 tick의 초기화와 실행은 계속된다.
- `scheduled()` 핸들러: trigger의 예정 시각(`scheduledTime`)으로 tick을 부르고 결과를 `info`로 남긴다. tick이 던지면 `error`로 남기고 다시 던진다.
- `0 7 * * *` 스케줄의 `next_run_at`과 `now`가 `2026-10-05T22:00:00.000Z`이면, ID가 `<스케줄 ID>-29853960`인 인스턴스를 만들고 `next_run_at`을 `2026-10-06T22:00:00.000Z`로 옮긴다.
- tick이 회차 시각보다 늦게 돈 경우: `5 9 * * *` 스케줄의 `next_run_at`이 `2026-10-05T00:05:00.000Z`이고 `now`가 `00:10`이면, 회차 `00:05`의 인스턴스 하나를 만들고 `next_run_at`을 `2026-10-06T00:05:00.000Z`로 옮긴다.
- 실행할 행이 250개면 `createBatch`를 100·100·50으로 세 번 부른다. 실행할 행이 없으면 부르지 않는다.
- `createBatch`가 던지면 tick도 던지고 `next_run_at`을 바꾸지 않는다.
- 요청 묶기: 실행할 행 250개는 `setSchedulerNextRuns`를 한 번만 부르고 250개 갱신을 함께 보낸다. 초기화는 페이지마다 한 번, 정리는 닫을 기록이 있을 때 한 번이다. 실행할 행 250개에 초기화 행과 닫을 기록이 있어도 tick 한 번의 Supabase 요청이 12개를 넘지 않는다.
- 정리: 수동 실행 기록은 실패로 닫는다. 인스턴스가 `running`·`waiting`이면 그대로 둔다. 인스턴스가 `errored`이거나 `get`이 던지면 `Run was interrupted`로 닫는다.

**회차 실행.** `step.do`가 callback을 바로 부르는 fake로 확인한다.
- 스케줄이 없거나, 꺼져 있거나, cron 식이 없으면 `cancelled`이고 실행 기록을 만들지 않는다.
- 정상 흐름: step 이름이 `begin-run`, `load-stages`, `stage-0`, `stage-1`, `finish-run` 순서다. 둘째 stage의 입력은 첫 stage의 출력이다. 기록은 `completed`, `result`는 마지막 stage의 출력이고, `last_run_at`이 갱신된다.
- stage step과 나머지 step의 설정이 위 표와 같다.
- 진행 중인 실행이 있으면 `skipped` 기록을 만들고 stage를 실행하지 않는다.
- 같은 회차의 기록이 이미 있으면 새로 만들지 않는다. `running`이면 이어서 실행하고, `completed`면 `finished`다.
- 첫 stage가 실패하면 둘째 stage를 실행하지 않고 기록은 `failed`다.
- fan-out이 일부 실패하면 `partially_failed`다. stage가 없으면 `completed`이고 `result`는 `null`이다.
- stage step이 던지면(시간 초과) `finish-run`이 `failed`로 실행된다.
- 어떤 step 반환값에도 stage의 출력이 없다.

**수동 실행.** 기존 테스트 세 개가 수정 없이 통과한다.

**웹.** `isScheduleMinuteAllowed`의 단위 테스트.

## 10. 배포할 때 주의할 점

- **기존 스케줄이 실제로 실행되기 시작한다.** 지금 켜져 있고 cron 식이 있는 스케줄이 대상이다. 배포 뒤 첫 tick은 `next_run_at`만 채우고, 그 뒤 첫 시각부터 실행한다. 원하지 않는 스케줄은 배포 전에 꺼 둔다.
- **기존 cron 식의 분이 10분 단위로 내려간다.** 마이그레이션이 사용자가 저장한 값을 바꾸고, 바꾼 스케줄은 전보다 최대 9분 일찍 실행된다. 되돌릴 원래 값은 남지 않는다.
- **마이그레이션을 워커보다 먼저 적용한다.** `main`에 push하면 마이그레이션과 워커 배포가 동시에 시작되어 순서가 보장되지 않는다. 워커가 먼저 올라가면 그동안 스케줄 저장이 실패하고 tick이 오류를 낸다. 머지 전에 `Deploy: Database Migrations`를 이 브랜치에서 수동으로 실행하면 된다.
- **운영 계정은 Workers Free다**(2026-10-04 확인, Workers Paid 구독 없음). tick은 요청을 묶어 한도 안에 든다. Workflow는 step당 CPU 시간이 10ms이고 외부 요청이 50개라, 긴 stage나 항목이 많은 fan-out은 걸릴 수 있다. Paid는 각각 30초와 10,000개다.
- **배포 워크플로는 바꾸지 않는다.** `wrangler deploy`가 cron trigger와 Workflow를 함께 올린다.
- 예약 실행이 진행 중일 때 수동 실행을 누르면 지금처럼 409가 온다. 수동 실행 중에 회차가 오면 그 회차는 건너뛴다.

## 11. 이번에 하지 않는 것

- 웹에서 시간대를 바꾸는 입력. API는 `timezone`을 받는다.
- 웹 실행 기록에 예약·수동을 구분해 보여 주는 칸. API 응답에는 `triggered_by`가 있다.
- 요일·시·분을 고르는 전용 입력 화면.
- 놓친 회차 보충, 실패한 실행의 자동 재시도.
- 웹 배포 빌드에 `VITE_SCHEDULER_MANAGER_WORKER_URL`이 빠진 문제(TES-197).

## 12. 확인한 외부 사실

2026-10-04에 공식 문서에서 확인했다.

- `createBatch`는 한 번에 100개까지 받고, 이미 있는 ID는 오류 없이 건너뛴다. `get(id)`는 ID가 없으면 던진다. 인스턴스 상태 값은 `queued`·`running`·`paused`·`errored`·`terminated`·`complete`·`waiting`·`waitingForPause`·`unknown`이다. ([Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/))
- 인스턴스 ID는 `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`, 100자 이하다. step 반환값 상한은 1MiB다. 요금제별 한도는 10절에 적었다. ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/))
