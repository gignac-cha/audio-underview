# 뉴스캐스트 2: 작업 그룹 "뉴스캐스트" (설계)

요구사항은 `documents/migration/08-newscast.md`, 이슈는 TES-265다. 1번(`2026-10-26-newscast-foundation.md`)의 패키지와 provider 키 위에, 스케줄 단계 한 칸으로 뉴스캐스트를 만드는 작업 그룹 워커를 만든다. 출처는 프로토타입 `ec5d226`의 `workers/newscast-pipeline-worker-prototype`이다. 순수 로직은 통째로 옮기고, seam만 바꾼다.

이 단위가 끝나면 다음이 된다.
- `geeknews-list` → 뉴스캐스트 그룹(위에서 3개)으로 된 스케줄을 실행하면 뉴스캐스트가 만들어진다.
- 뉴스캐스트를 API로 조회, 재생(Range), 공유할 수 있다.

웹 화면(4번), 폼 단계와 템플릿(3번)은 이 PR 안에서 이어서 만든다.

## 1. 흐름

1. scheduler가 그룹 단계에서 `NEWSCAST` binding의 `startTaskGroupRun(request)`를 부른다.
2. 그룹은 입력에서 출처 목록을 만들고, 출처마다 `newscasts` 행 하나와 Workflow 인스턴스 하나를 만든 뒤 바로 반환한다(5분 안).
3. 인스턴스마다 다음을 한다.
   - 글 읽기
   - 정리
   - 시그널: 설정이 켜져 있고 파트가 둘 이상일 때만
   - 파트 대본
   - TTS
   - 오디오
   - 마무리
4. 인스턴스가 끝날 때마다 같은 단계 실행의 뉴스캐스트를 모두 본다.
   - 모두 끝났으면 `TaskGroupReports.complete`, 모두 실패했으면 `fail`을 보낸다.
   - 아직 남았으면 `reportProgress("k of N newscasts finished", completed: k, total: N)`를 보낸다.
   - 두 인스턴스가 동시에 마지막이라고 보고해도 된다. scheduler의 보고는 같은 단계 실행에 대해 한 번만 받아들인다.

## 2. 그룹 입력·설정·출력과 등록

### 입력

입력은 앞 단계 출력이고, 넷 중 하나다.

| 입력 | 출처 |
| -- | -- |
| 배열 `[{ title, discussionUrl, originalUrl }, …]` (`geeknews-list` 출력) | 앞에서 `article_limit`개 |
| `{ articles: [{ title, discussionUrl, originalUrl }, …] }` (폼의 고르기) | 전부(최대 10) |
| `{ url }` | 그 URL의 글 하나 |
| `{ text, title? }` | 직접 입력한 글 하나(최대 24,000자) |

- 출처가 하나도 없거나 위 형식이 아니면, `startTaskGroupRun`이 오류를 던져 단계를 실패시킨다. 오류 문구는 무엇이 잘못됐는지 말한다.
- `userUUID`는 소문자 UUID로 검사한다. vault는 다른 형식을 400으로 거절하기 때문이다.

### 설정

설정 schema는 평평하게 둬서 웹 설정 입력란이 그대로 그리게 한다.

| 키 | 형식 | 기본값 | 뜻 |
| -- | -- | -- | -- |
| `provider` | enum `google`, `anthropic`, `openai`, `xai` | `google` | 대본 provider |
| `model` | string | `""` | 비우면 provider의 기본 모델(프로토타입 `defaultModelForProvider`) |
| `effort` | enum `""`, `none`, `low`, `medium`, `high`, `xhigh`, `max` | `""` | 비우면 보내지 않는다 |
| `length` | enum `short`, `standard`, `long` | `standard` | 길이 |
| `tts_model` | enum `TTS_MODELS`(newscast-core) | `DEFAULT_TTS_MODEL` | TTS 모델 |
| `signal` | boolean | `false` | 켜면 파트가 둘 이상일 때 시그널을 만든다 |
| `verbatim` | boolean | `false` | `{ text }` 입력일 때 원문 낭독 |
| `article_limit` | integer 1~10 | `3` | 배열 입력에서 앞의 몇 개 |

- 화자는 프로토타입처럼 뉴스캐스트마다 남녀 한 쌍을 무작위로 고른다.

### 출력

출력은 `{ newscasts: [{ id, status, title }] }`다.
- `status`는 `done` 또는 `error`다.
- 하나라도 `done`이면 `complete`, 모두 `error`면 `fail`("All N newscasts failed: <첫 오류>")을 보낸다.

### 등록

등록은 migration 016에 `task_groups` 행 하나를 넣는 것이다.
- `('newscast', 1, <입력 schema>, <설정 schema>, <출력 schema>, 'NEWSCAST')`
- 입력 schema는 `{ "type": ["array", "object"] }`로 넓게 두고, 자세한 검사는 워커가 한다.
- schema는 scheduler 검사가 아는 키워드(`type`, `enum`, `minimum`, `maximum`, `minItems`, `maxItems`, `items`, `properties`, `required`, `additionalProperties`, `title`, `description`, `default`)만 쓴다.

## 3. 저장소

### migration `016_create_newscast_tables.sql`

```sql
CREATE TABLE newscasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  stage_run_id UUID REFERENCES scheduler_stage_runs(id) ON DELETE SET NULL,
  source_index INTEGER NOT NULL CHECK (source_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  stage TEXT NOT NULL,
  stage_progress REAL NOT NULL DEFAULT 0,
  overall_progress REAL NOT NULL DEFAULT 0,
  title TEXT,
  title_override TEXT,
  request JSONB NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stage_run_id, source_index)
);
CREATE INDEX newscasts_user_created_index ON newscasts (user_uuid, created_at DESC);

CREATE TABLE newscast_shares (
  token TEXT PRIMARY KEY,
  newscast_id UUID NOT NULL UNIQUE REFERENCES newscasts(id) ON DELETE CASCADE,
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  included_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- 두 테이블 다 RLS를 켜고, 테이블마다 `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE <t> TO service_role;`를 CREATE 뒤에 둔다(015 뒤 규칙).
- `updated_at` 갱신은 워커가 쓸 때 함께 넣는다.
- 같은 파일에 `task_groups` 행을 넣는다.
- `request`는 그 뉴스캐스트의 출처와 설정이다. `details`는 단계별 기록이고, 프로토타입 `JobDetails`와 같은 모양이다. `result`는 프로토타입 `NewscastResult`와 같은 모양이다. JSON 안의 이름은 newscast-core의 camelCase 그대로다.
- staging 복사에서 `newscasts`와 `newscast_shares`를 뺀다(`UNCOPIED_TABLES`). 오디오가 운영 R2에 있어 staging에서는 재생되지 않기 때문이다. 테이블은 만들어지고 비어 있다.

### R2와 KV

- **R2 `NEWSCAST_AUDIO`:**
  - 버킷 이름: `audio-underview-newscast-audio`, `-staging`, `-development`, `-docker`
  - 키: `<newscastID>/part-<N>`, `<newscastID>/signal`
- **KV `NEWSCAST_STATE`:**
  - TTS chunk PCM: `seg/<newscastID>/p<N>/<chunk>`
  - checkpoint: `chk/<userUUID>/<newscastID>/…`
  - 둘 다 7일 TTL을 붙인다. 마무리에서 지우는 것은 프로토타입과 같다. 프로토타입은 TTL이 없어 실패한 뉴스캐스트의 PCM이 남았다.

## 4. 워커 `workers/newscast-worker`

- **패키지와 이름:** `@audio-underview/newscast-worker`. 워커 이름은 `audio-underview-newscast-worker`, `-staging-`, `-development-`, `-docker-`. development 이름은 43자다.
- **export:** 셋을 내보낸다.
  - `default`: HTTP(아래 5절)
  - `NewscastTaskGroup`(`WorkerEntrypoint`): `startTaskGroupRun`
  - `NewscastWorkflow`(`WorkflowEntrypoint`)
- **wrangler.toml:** production과 `[env.staging|development|docker]`마다 다음을 둔다. 다른 워커처럼 env가 물려받지 않는 것은 반복한다.
  - vars: `SUPABASE_SCHEMA`, `ALLOWED_ORIGINS`
  - services:
    - `USER_VAULT` → user-vault
    - `CRAWLER_MANAGER` → crawler-manager(`executeCrawlerByName` RPC)
    - `SCHEDULER_TASK_GROUP_REPORTS` → scheduler-manager, `entrypoint = "TaskGroupReports"`
  - R2 `NEWSCAST_AUDIO`, KV `NEWSCAST_STATE`
  - workflow `NEWSCAST_WORKFLOW`: 이름 `audio-underview-newscast-workflow`, `audio-underview-newscast-<env>-workflow`, class `NewscastWorkflow`
  - `[limits] cpu_ms = 300000`(프로토타입과 같음, MP3 인코딩)
  - KV id는 아직 없으니 placeholder로 두고, 만든 뒤 채운다(8절).
- **secret:** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`, `VAULT_INTERNAL_TOKEN`. 값은 crawler-manager와 같은 1Password 항목에 있다.
- **provider 호출:** 사용자 키로만 한다. 프로토타입 `createUserKeyTransport`를 main vault(`USER_VAULT`, `https://user-vault.internal/internal/proxy`, 헤더 `x-user-vault-token`)에 맞춰 옮긴다.
  - 키가 없으면(`no_key`) `blocked_no_key`로 끝난다.
  - 운영자 키, trial, AI Gateway 직접 경로, 자체 인증은 옮기지 않는다.
- **provider별 키:**
  - 대본: 설정의 provider 키
  - TTS·시그널: Google 키
  - 단어 시각(Whisper): OpenAI 키가 있으면 쓰고, 없으면 정렬 없이 추정 시각을 쓴다.
- **글 읽기:** 프로토타입 `crawl-articles`의 글별 크롤을 `CRAWLER_MANAGER.executeCrawlerByName`으로 그대로 한다(`article-content`, `geeknews-summary`, `hn-search`, `hn-items`).
  - `{ url }`은 `article-content`만 쓴다.
  - `{ text }`는 읽지 않는다.
  - `crawl-list` 단계는 옮기지 않는다. 목록은 앞 단계가 준다.
- **Workflow 단계와 재시도·시간 설정**은 프로토타입 `workflow.ts`의 것을 그대로 쓴다. 시그널만 `signal` 설정이 켜져 있을 때 만든다.
- **그대로 옮기는 파일(seam만):** `checkpoints.ts`, `audio-lookup.ts`, `custom-article.ts`(trial 검사 제외), `failure-details.ts`, `signal-sting.ts`, `shares.ts`의 공개 DTO 부분, `storage.ts`의 순수 함수, 그 테스트들.
- **이번에 하지 않는 것:** 실패한 뉴스캐스트 다시 잇기(resume), 제목 외의 편집, 삭제

## 5. HTTP route (default export)

인증은 crawler-manager와 같다. main 세션 JWT(`JWT_SECRET`, HS256, `sub` = 사용자 UUID)를 쓰고, `jid` claim이 있는 토큰은 세션으로 받지 않는다. CORS는 `ALLOWED_ORIGINS`다. 응답 JSON의 이름은 프로토타입과 같은 camelCase다(웹 화면을 그대로 옮기기 위해).

| method, path | 인증 | 응답 |
| -- | -- | -- |
| `GET /newscasts` | 세션 | `200 { data: NewscastJobSummary[] }`, 최근 20개 |
| `GET /newscasts/:id` | 세션 | `200 JobStatus`, 남의 것은 404 |
| `POST /newscasts/:id/title` `{ title }` | 세션 | `200 { id, title }`, 200자까지 |
| `POST /newscasts/:id/media-token` | 세션 | `200 { token, expiresIn }` |
| `GET /newscasts/:id/audio?part=N\|signal` | 세션 또는 `?token=` media token | 오디오. Range를 지원한다(프로토타입 그대로) |
| `PUT /newscasts/:id/share` `{ metadata?, regenerate? }` | 세션 | `200 { token }`. 끝나지 않은 뉴스캐스트는 `409 job_not_shareable` |
| `GET /newscasts/:id/share` | 세션 | `{ shared: false }` 또는 `{ shared: true, token, metadata }` |
| `DELETE /newscasts/:id/share` | 세션 | `{ removed }` |
| `GET /share/:token` | 없음 | `PublicShareView`(프로토타입 allowlist 그대로) |
| `GET /share/:token/audio?part=N\|signal` | 없음 | 오디오, Range |

- **media token:** `{ sub, jid: newscastID, iat, exp = iat + 3600 }`를 HS256으로 서명한다.
  - 서명 키는 `JWT_SECRET`가 아니라 `HMAC-SHA256(JWT_SECRET, "newscast-media-token")`로 만든 키다. 그래서 media token은 다른 워커에서 세션으로 통하지 않는다.
  - `?token=`으로만, 오디오 route에서만 받는다.
- **공유 화면 값:** 공유 화면에 넣는 이름·이메일(`metadata.displayName`, `email`)은 프로토타입처럼 웹이 보낸 값을 쓴다.

## 6. scheduler-manager-worker

- production과 env 셋에 다음을 더한다.

  ```toml
  [[services]]
  binding = "NEWSCAST"
  service = "audio-underview-newscast[-<env>]-worker"
  entrypoint = "NewscastTaskGroup"
  ```
- `vitest.config.ts`의 service stub과 `tests/wrangler-environments.test.ts`에 같은 것을 더한다.

## 7. 다섯 환경

- **deploy-environment.yml:**
  - 워커 이름 검사 목록에 `newscast`를 넣는다.
  - user-vault → crawler-manager → **newscast** → scheduler-manager 순서로 배포한다.
- **production 배포:** `deploy-newscast-worker.yml`(workflow_dispatch)을 두고 `DEPLOYMENT_TARGETS`에 넣는다.
- **production 첫 배포 순서:** 계획기는 workflow를 병렬로 부른다. 그래서 머지 뒤 첫 배포만은 newscast를 scheduler보다 먼저 수동으로 돌린다.
- **local:** `pnpm dev`에 `--filter=@audio-underview/newscast-worker`를 더한다. 포트는 8792, inspector는 9335.
  - `tools/environment-generator`가 `workers/newscast-worker/.dev.vars.development`를 만든다(`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `JWT_SECRET`, `VAULT_INTERNAL_TOKEN`).
- **docker:** `docker/workers/start-workers.ts`와 `compose.yaml`에 newscast(9792, inspector 9335)를 더한다. "워커 다섯" 문구도 고친다.
- **테스트:** 다른 워커처럼 `tests/wrangler-environments.test.ts`와 `tests/supabase-schema-call-sites.test.ts`를 둔다.

## 8. 사람이 준비할 것(배포 전)

1. Cloudflare(outlook 계정):
   - R2 버킷 셋: `audio-underview-newscast-audio`, `-staging`, `-development`
   - KV namespace 셋. 만든 id를 wrangler.toml에 넣는다.
2. 환경 셋(staging, development, production)의 newscast 워커 secret 넷을 1Password 항목에서 올린다.
3. migration 016은 staging·development에는 배포 workflow가, production에는 머지 뒤 migration workflow가 넣는다.

## 9. 확인

- 새 워커, scheduler, environment-schema, deployment-planner의 typecheck·테스트와 루트 `pnpm typecheck`
- development 배포 뒤:
  - `geeknews-list` → 뉴스캐스트 그룹(위에서 1개) 스케줄을 Run now로 돌린다.
  - 단계 실행이 completed가 되고, 출력에 `done` 뉴스캐스트가 있다.
  - `GET /newscasts/:id`에 파트가 있고, `audio?part=1`이 Range로 재생된다.
  - 공유 링크가 로그인 없이 열린다.
  - 사용자의 Google 키가 필요하다.

## 10. 추적 목록

| 항목 | 상태 | 원인 | 재접속 |
| -- | -- | -- | -- |
| 웹 뉴스캐스트 화면 | 미접속 | 4번 | TES-267 |
| 폼 단계, 템플릿 | 미접속 | 3번 | TES-266 |
| 일반 사용자가 `geeknews-list`를 단계에 넣기 | 미접속 | 구독이 아직 없음 | 3번 템플릿에서 구독 행을 만든다 |
| 실패한 뉴스캐스트 다시 잇기(resume) | 미접속 | 이번에 하지 않음 | 나중 |
| 키 등록 rate limit | 미접속 | 1번과 같음 | TES-248 |
