# 뉴스캐스트 3·4: 폼 단계, 템플릿, 웹 화면, 공유 화면 (설계)

요구사항은 `documents/migration/08-newscast.md`, 이슈는 TES-266(폼 단계와 템플릿)과 TES-267(웹 재생 화면과 공유)이다. 2번(`2026-10-26-newscast-task-group.md`)의 그룹 워커 위에 다음을 만든다.

1. 스케줄의 새 단계 종류 "폼"(사용자 대기)
2. 뉴스캐스트 템플릿 스케줄(뺐다, 2번)
3. 웹 뉴스캐스트 화면
4. 공개 공유 화면(share-viewer)

출처는 프로토타입 `ec5d226`의 `applications/web-prototype`(뉴스캐스트 화면)과 `applications/share-viewer-prototype`이다. 데모: https://claude.ai/artifact/AmF9DmEmUtyZsZBB11STS1

## 1. 폼 단계 (scheduler-manager-worker)

### 단계

- `stage_type = 'form'`. 크롤러와 그룹 칸은 비우고, fan-out은 없다. `input_schema`, `output_schema`는 `{}`다.
- 단계의 `settings`는 `{ form: <폼 정의>, timeout_minutes?: 1~525600 }`다. 기본은 1440(24시간)이다.
- **폼 정의:** 답(다음 단계 입력)의 JSON Schema다. 최상위는 `{ type: 'object', properties, required? }`이고, 필드 순서는 필드의 `x-order`(0 이상 정수, 없으면 뒤로)와 이름순으로 정한다.
  - 필드마다 scheduler schema 검사가 아는 키워드에 더해 둘을 쓴다.
    - `x-widget`: `checkboxes` | `radio` | `select` | `text` | `textarea` | `number` | `toggle`
    - `x-options`: `{ from: '$' | '$.<경로>', label: '<항목 안 경로>' | '$', description?: '<경로>', value?: '<경로>' }`. `value`를 생략하면 항목 전체다.
  - 위젯과 형식은 맞아야 한다.
    - `checkboxes`는 `type: 'array'`다. 선택지는 `x-options`나 `items.enum`에서 온다.
    - `radio`와 `select`는 `x-options`나 `enum`을 쓴다.
    - `text`와 `textarea`는 `type: 'string'`이다. `text`는 `format: 'uri'`를 쓸 수 있다.
    - `number`는 `number` 또는 `integer`다.
    - `toggle`은 `boolean`이다.
  - 단계를 저장할 때 검사하고, 틀리면 400이다.
- **schema 검사(`schema-validation.ts`):**
  - `x-`로 시작하는 키는 주석처럼 넘긴다. 내용은 폼 검사가 따로 본다.
  - `format: 'uri'`를 받는다. 값은 `http`나 `https` URL이어야 한다.
  - 다른 `format` 값은 지금처럼 거절한다.

### 실행

- **migration 017:**
  - `scheduler_run_status`에 `'waiting'`을 더한다.
  - `scheduler_stages_type_check`에 `form` 갈래를 더한다.
  - `scheduler_stage_runs`에 `form JSONB` 컬럼을 더한다.
- **migration 018:** `fail_scheduler_runs`가 `waiting` stage run도 닫게 바꾼다. 새 enum 값을 만든 transaction에서 쓰지 않으려고 파일을 나눈다.
- 회차는 `running`으로 두고, 폼 stage run만 `waiting`이 된다. 진행 중 회차가 하나라는 규칙과 schedule tick은 그대로다.
- **수동 실행:** 그룹이나 폼 단계가 있으면 Workflow로 보내고 202로 답한다. 바로 도는 실행기는 폼 단계를 거절한다.
- **Workflow:** 작업 그룹 단계를 본떠 세 step으로 돈다.
  1. **시작 step:** 같은 stage run이 있으면 다시 만들지 않는다.
     - 앞 단계 출력(첫 단계면 `{}`)을 입력으로 남긴다.
     - `x-options`를 풀어 "풀린 폼"을 만든다. 선택지는 최대 200개, 라벨은 300자로 자른다.
     - stage run을 `waiting`으로 만들고, `form`에 다음을 저장한다.
       ```json
       { "schema": "<x- 키를 뺀 JSON Schema. 선택지는 정수 enum 0…n-1>", "fields": [{ "name", "title?", "description?", "widget", "required", "choices?": [{ "label", "description?" }], "minItems?", "maxItems?", "maxLength?", "minimum?", "maximum?", "default?" }], "expires_at": "ISO" }
       ```
     - `from` 경로가 배열이 아니거나 비어 있으면 `Stage N: no choices for '<name>'`로 실패한다.
  2. **대기:** `step.waitForEvent`, type `form-answered-<stageRunID>`, timeout `timeout_minutes`
  3. **정리 step:** 아직 `waiting`이면 `failed`로 바꾸고 `Stage N: no answer within <분> minutes`를 남긴다.
     - `completed`이면 그 출력이 다음 단계 입력이 된다.
     - `failed`(취소)면 회차를 실패로 끝낸다.
- `failActiveSchedulerStageRuns`와 웹의 진행 중 판정에 `waiting`을 더한다.

### API

- **답:** `POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/answer` `{ answer: object }`
  - 남의 스케줄이나 없는 회차는 404다. 폼 stage run이 `waiting`이 아니면 `409 not_waiting`("This stage is not waiting for an answer")이다.
  - 풀린 `schema`로 검사한다. 배열의 같은 번호는 한 번만 받는다. 틀리면 `400 invalid_answer`이고, 경로와 이유를 준다.
  - 번호를 앞 단계 출력의 항목(`value` 경로)으로 바꿔 출력에 저장하고 `completed`로 바꾼다. `waiting`일 때만 바꾸는 guard를 둔다.
  - 그다음 회차 Workflow에 `form-answered-<stageRunID>`를 보낸다. 응답은 `200 { status: 'completed' }`다.
- **취소:** `POST /schedulers/:id/runs/:runID/stage-runs/:stageRunID/cancel`
  - `waiting` 폼을 `failed`("Stage N: cancelled by the owner")로 바꾸고 회차를 깨운다. 응답은 `200 { status: 'failed' }`다.
  - `waiting`이 아니면 `409 not_waiting`이다.
- `HELP`에 두 route를 더한다.

### 웹 (스케줄러 화면)

- `waiting` 상태 배지는 "Waiting for answer"다. 회차 목록과 stage run이 계속 갱신된다.
- `StageRunList`의 `waiting` 폼 줄에 Answer 버튼을 둔다.
  - 버튼을 누르면 `AnswerFormDialog`가 stage run의 `form.fields`로 위젯을 그린다. 라벨은 텍스트로만 그린다.
  - 체크박스는 고른 수와 최대 수를 보여 준다. 답을 보내고, Cancel run으로 회차를 끝낼 수 있다.
- 단계 추가·수정 대화상자에 Form 종류를 둔다. 폼 정의 JSON 입력란(예시가 들어 있음)과 기다리는 시간(분)을 받는다.
- 단계 이름은 "Form"으로 보인다.

## 2. 뉴스캐스트 템플릿 (뺐다)

- 템플릿 스케줄과 웹의 만들기 패널은 2026-10-26에 뺐다. 뉴스캐스트는 Schedulers 화면의 스케줄(목록 → 글 고르기 폼 → 뉴스캐스트 단계)로만 만들기 때문이다.

## 3. 웹 뉴스캐스트 화면 (applications/web)

- **route와 메뉴:** route `/newscasts`(ProtectedRoute)와 메뉴 "Newscasts"를 더한다. 스타일은 크롤러·스케줄러·설정 화면과 같은 기존 스타일(PageHeader, NavigationLinks, `global.scss` 변수, `useToast`, `DiscardDialog`, 영어 문구)이다.
- **환경 변수:** `VITE_NEWSCAST_WORKER_URL`과 `VITE_SHARE_VIEWER_URL`을 환경 schema(`schemas/environment.ts`)에 더한다. 요청 helper는 다른 helper처럼 값이 없으면 오류를 낸다.
- **옮기는 것:** 프로토타입 `components/newscast/`의 보기·재생·공유 부분과 `use-newscast-jobs.ts`의 조회·media token·URL 부분, `use-newscast-share.ts`를 옮긴다. 바꾸는 것은 다음과 같다.
  - 경로 `/newscast/jobs` → `/newscasts`. 목록은 `{ data }`다.
  - 패키지 이름은 main 이름이고, 문구는 영어다. 화자는 Host 1 / Host 2, 파트는 "Part N"이다.
  - `formatting.ts`는 ISO 시각을 읽는다(Postgres TIMESTAMPTZ).
  - `NewscastSources`는 빈 `discussionUrl`이면 토론 링크를 그리지 않는다.
  - 재생 가능 여부는 "done이고 파트가 있음"으로 본다(통짜 오디오가 없다).
  - 오류 패널에서 다시 잇기, 같은 조건으로, 조건 바꿔서 버튼은 뺀다. `blocked_no_key`는 Settings로 안내한다.
  - media token 갱신(수명의 절반)과 재생 중 URL 고정(9741051)은 그대로다.
  - 파이프라인 그래프(d3)도 옮긴다.
- **만들기는 없다:** 화면은 목록, 재생, 공유만 한다. 목록이 비었으면 스케줄이 뉴스캐스트를 만든다고 알리고 Schedulers(`/schedulers`)로 잇는다.
- **테스트:** main 방식(브라우저 모드, MSW, `vitest-browser-react`)으로 다시 쓴다. 프로토타입 테스트가 확인하던 동작은 남긴다. 특히 재생 중 URL이 바뀌지 않는 것, 시그널을 같은 요소로 재생하는 것, 파트 넘김을 확인한다.

## 4. 공개 공유 화면 (applications/share-viewer)

- 프로토타입 `share-viewer-prototype`을 `applications/share-viewer`(`@audio-underview/share-viewer`)로 통째로 옮긴다.
  - 화면은 프로토타입처럼 한국어다.
  - 이름, 패키지, 워커 주소만 바꾼다.
  - 테스트(jsdom)도 그대로 옮긴다.
- **Pages 프로젝트:** `audio-underview-share`
  - 주소: production `https://audio-underview-share.pages.dev`, staging과 development는 `--branch=staging|development` 고정 주소다.
- **워커 주소:** Pages 환경 변수는 production과 preview 둘뿐이라, 환경마다 다르게 둘 수 없다. 그래서 배포 job이 빌드 전에 두 곳에 넣는다.
  - `functions/worker-url.generated.ts`(Function용): 저장소에는 production 값을 둔다.
  - `VITE_NEWSCAST_WORKER_URL`(client)
- **배포:**
  - `deploy-environment.yml`에 share-viewer job을 두고, 이 앱 디렉터리에서 `pages deploy`를 해서 `functions/`가 함께 올라가게 한다.
  - production은 `deploy-share-viewer.yml`(workflow_dispatch)과 `DEPLOYMENT_TARGETS`다.
  - 테스트는 CI test workflow에 더한다.
- **웹과 연결:** 웹의 공유 링크는 `${VITE_SHARE_VIEWER_URL}/share/<token>`이다.

## 5. 다섯 환경과 변수

- **GitHub 변수(사람이 넣음):**
  - `VITE_NEWSCAST_WORKER_URL`과 `VITE_SHARE_VIEWER_URL`
  - 각각의 `STAGING_`·`DEVELOPMENT_` 판
- **validate job:** 다른 변수처럼 비었는지, 운영과 같은지 검사한다.
- **local과 docker:**
  - local: 웹 `VITE_NEWSCAST_WORKER_URL=http://localhost:8792`
  - docker: `http://localhost:9792`
  - share-viewer는 `pnpm dev`에 넣지 않는다. 따로 띄운다.

## 6. 확인

- scheduler, newscast 워커, 웹, share-viewer, 도구의 typecheck·테스트와 루트 `pnpm typecheck`
- development에서 확인한다.
  1. Schedulers에서 `geeknews-list` → 폼 → 뉴스캐스트 그룹 스케줄을 Run now로 돌리고, Answer로 글 1개를 고른다.
  2. 뉴스캐스트가 만들어져 목록에 진행이 보이고, 재생과 자막이 된다.
  3. 공유 링크가 로그인 없이 share-viewer에서 열리고 미리보기가 붙는다.
  4. 스케줄 화면에서 Cancel도 확인한다.

## 7. 추적 목록

| 항목 | 상태 | 원인 | 재접속 |
| -- | -- | -- | -- |
| 구독 API와 공식 크롤러 목록 | 미접속 | 구독 행이 없으면 일반 사용자는 `geeknews-list`를 단계에 넣지 못함 | TES-268 |
| 실패한 뉴스캐스트 다시 잇기 | 미접속 | 2번에서 뺌 | 나중 |
| 알림(폼이 기다림) | 미접속 | 08에서 뺌 | 나중 |
