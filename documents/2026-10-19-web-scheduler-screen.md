# 웹 스케줄러 화면 설계

작성일 2026-10-19. 기준 코드는 `main`(`0b97403`)이다. 범위는 2026-10-14에 정한 "웹 스케줄러 화면"이다(Linear TES-249의 스케줄러 부분과 TES-197). 이관이 아니라 메인에서 직접 만든다. 기능만 붙이고 디자인은 지금 그대로 둔다.

## 1. 지금 있는 것과 만들 것

지금 웹 스케줄러 상세 화면(`/schedulers/:id`)에서 되는 것:
- 이름, cron 식, 켜기·끄기, 시간대를 고친다. 다음 실행 시각과 마지막 실행 시각을 본다(05에서 만듦).
- 크롤러 단계를 추가하고, 지우고, 끌어서 순서를 바꾼다.
- 실행 기록 목록을 보고, 한 줄을 펼쳐 회차의 오류와 결과를 본다. 건너뛴 회차는 `Skipped`로 보인다.
- 작업 그룹 단계는 이름(`Task group <id> v<버전>`)만 보인다(06에서 깨지지 않게만 함).

만들 것:
1. **단계 고치기.** 지금은 고칠 방법이 없어 지우고 다시 만들어야 한다. 크롤러 단계는 크롤러, 입력 형식, fan-out 필드와 방식을, 작업 그룹 단계는 버전과 설정을 고친다.
2. **작업 그룹 단계 만들기.** 단계를 추가할 때 크롤러와 작업 그룹 중 고르고, 그룹이면 그룹·버전을 고른 뒤 설정을 채운다.
3. **수동 실행 버튼(Run now).** 지금 웹에는 실행 버튼이 없어서, 예약 시각을 기다리지 않으면 파이프라인을 돌려 볼 수 없다. TES-249의 "만들고 돌리고 확인한다"에 해당한다.
4. **단계별 실행 기록.** 회차를 펼치면 단계마다 상태, 걸린 시간, fan-out 항목 수, 작업 그룹의 진행 상황, 오류를 보여 준다. 단계를 누르면 그 단계의 입력, 출력, 파일, 로그를 보여 준다. 진행 중인 회차는 저절로 새로 고친다. 목록에 수동·예약 구분 칸을 더한다.
5. **TES-197.** 웹 배포 build에 scheduler 주소(`VITE_SCHEDULER_MANAGER_WORKER_URL`)를 넣는다. 지금은 빠져 있어서 운영 웹의 스케줄러 화면이 서버를 부르지 못한다.

고치는 곳은 `applications/web`, `.github/workflows/deploy-web.yml`, `documents`다. 서버(connector, scheduler-manager, crawler-manager)와 DB는 바꾸지 않는다. migration도 없다. 새 npm 의존성은 없다.

## 2. 결정

**서버는 고치지 않는다.** 필요한 API가 모두 있다.

| 쓰는 곳 | API |
| -- | -- |
| 그룹 목록 | `GET /task-groups` → `{ data: [{ id, version, input_schema, settings_schema, output_schema, created_at }] }`, `id`·`version` 오름차순 |
| 단계 만들기 | `POST /schedulers/:id/stages`. 그룹 단계는 `{ stage_type: 'task_group', task_group_id, task_group_version, settings, stage_order }` |
| 단계 고치기 | `PUT /schedulers/:id/stages/:stageID`. 크롤러 단계는 `crawler_id`, `input_schema`, `output_schema`, `fan_out_field`(`null`이면 지움), `fan_out_strategy`. 그룹 단계는 `task_group_version`, `settings`. 종류와 그룹은 바꿀 수 없다 |
| 수동 실행 | `POST /schedulers/:id/execute`. 크롤러 단계만 있으면 요청 안에서 끝까지 실행하고(최대 5분) 회차를 돌려준다. 그룹 단계가 있으면 `202`로 바로 돌려준다. 진행 중인 회차가 있으면 `409` |
| 회차 한 건 | `GET /schedulers/:id/runs/:runID` → 회차와 `stage_runs`(입력·출력·로그 없이, `stage_order` 순서, 그룹의 `progress` 포함) |
| 단계 실행 한 건 | `GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID` → 입력, 출력, 로그, `logs_truncated` 포함 |

서버가 형식을 검증하고 어긋난 곳을 문구로 돌려준다(예: `Field 'settings' does not match the task group settings format: $.title is required`). 웹은 그 문구를 그대로 toast로 보여 준다. 웹에서 같은 검증을 다시 구현하지 않는다.

**그룹 설정은 형식으로 만든 입력 칸으로 채운다.** 사용자가 JSON을 직접 쓰지 않아도 되게 한다. 그룹의 `settings_schema`(06의 JSON Schema 일부)를 읽어 최상위 `properties`마다 칸을 하나 만든다.

| 필드 형식 | 입력 칸 |
| -- | -- |
| `enum`이 있음 | 선택 목록 |
| `type: 'string'` | 글자 입력 |
| `type: 'number'`, `'integer'` | 숫자 입력 |
| `type: 'boolean'` | 체크박스 |
| 그 밖(`object`, `array`, 여러 `type`, `type` 없음) | 그 필드만 JSON 입력 |

- 칸의 이름은 `title`이 있으면 `title`, 없으면 필드 이름이다. `description`은 칸 아래 도움말로, `required`에 든 필드는 이름 옆에 표시한다. 새 단계의 초깃값은 `default`다.
- 비운 칸은 설정에 넣지 않는다(선택 목록은 빈 선택지가 비운 칸이다). 체크박스는 항상 `true`나 `false`로 들어간다. 필수 칸을 비우면 서버가 `is required`로 거절한다. 숫자 칸에 숫자가 아닌 값, JSON 칸에 JSON이 아닌 값이 있으면 보내지 않고 toast로 알린다.
- 형식의 최상위가 `type: 'object'`가 아니거나 `properties`가 없으면 설정 전체를 JSON 하나로 입력한다.
- 크롤러 단계의 `Edit JSON`처럼 `Edit JSON`을 누르면 설정 전체를 JSON으로 고칠 수 있다. 돌아오면 JSON의 값으로 칸을 다시 채운다. JSON이 객체가 아니면 돌아가지 않고 알린다.

**버전.** 새 그룹 단계의 기본 버전은 그 그룹의 가장 높은 버전이다. 단계를 고칠 때 버전을 바꾸면 입력 칸을 새 버전의 형식으로 다시 만들고, 이름이 같은 필드의 값은 유지한다. 단계 카드는 더 높은 버전이 등록돼 있으면 `v<n> available`을 보여 준다.

**등록된 그룹이 없으면** 단계 추가의 `Task group` 선택지를 막고 `No task groups are available yet.`을 보여 준다. 지금 운영에는 등록된 그룹이 없다(뉴스캐스트 단위에서 생긴다). 그룹 목록을 읽지 못하면 크롤러 단계 추가는 그대로 되고, 그룹 선택지만 막고 오류를 보여 준다.

**단계 고치기는 바뀐 필드만 보낸다.** 고치기 대화상자는 지금 값으로 채워 열고, 저장할 때 달라진 필드만 `PUT`에 넣는다. 바뀐 것이 없으면 요청하지 않고 닫는다. fan-out 필드를 비우면 `fan_out_field: null`을 보낸다. fan-out 방식(`compact`·`preserve`) 선택은 fan-out 필드가 있을 때만 보이고, 단계 추가에도 같은 선택을 더한다. 기본은 `compact`(서버 기본값과 같다).

**수동 실행.**
- 버튼은 상세 화면의 `Pipeline Stages` 제목 줄에 둔다. 단계가 없으면 막는다. 요청 중에는 `Running...`이고 다시 누를 수 없다.
- 크롤러 단계만 있는 스케줄은 서버가 끝까지 실행한 뒤 답하므로 최대 5분을 기다린다. 웹의 제한 시간은 크롤러 화면과 같은 330초다.
- 응답 본문에 `run_id`가 있으면 상태 코드가 실패(`408`, `422`, `500` 등)여도 회차는 기록된 것이다. 실행 기록을 새로 읽고 그 회차를 펼친다. 실패면 오류 문구를 toast로도 보여 준다.
- `202`(그룹 단계가 있음)는 회차를 펼치고 진행 중으로 보여 준다. 진행은 아래 새로 고침으로 따라간다.
- `409`는 `A run is already in progress` toast다. `run_id`가 없는 그 밖의 실패는 서버 문구를 toast로 보여 준다.
- 실행이 끝나면 스케줄(마지막 실행 시각)도 새로 읽는다.

**실행 기록.**
- 목록 칸은 `Status`, `Trigger`(`Manual`·`Scheduled`), `Started`, `Duration`이다. `Started`는 지금처럼 시작 시각이 없으면 예정 시각이다.
- 회차를 펼치면 `GET …/runs/:runID`를 읽어, 지금 보여 주는 회차의 오류·결과 위에 단계 실행 목록을 보여 준다. 줄마다 순서, 단계 이름, 상태, 걸린 시간을 보여 준다. fan-out이면 `<성공>/<전체> items`와 실패 수를, 그룹 단계면 진행 상황(`message`, `completed`/`total`, 알린 시각)을, 실패면 오류를 함께 보여 준다.
- 단계 이름은 지금 단계 목록에서 `stage_id`로 찾는다. 크롤러면 크롤러 이름이고, 그룹이면 기록에 적힌 `task_group_id`와 버전이다. 단계를 지웠으면 `Stage <순서>`다.
- 단계 실행을 누르면 `GET …/stage-runs/:stageRunID`를 읽어 Input, Output, Files, Logs를 보여 준다. 크롤러 화면의 출력·파일·로그 표시 부품을 그대로 쓴다. 로그가 잘렸으면 `Logs were truncated.`를 보여 준다. 파일은 crawler-manager에서 세션 토큰으로 받는다(스케줄 소유자가 보는 사람이다).
- 진행 중(`pending`·`running`)인 회차가 목록에 있으면 목록을 5초마다 다시 읽는다. 펼친 회차가 진행 중이면 그 회차도 5초마다 다시 읽는다. 모두 끝나면 멈춘다. 펼친 단계 실행의 입력·출력·로그는 그 단계가 끝났을 때 다시 한 번 읽는다.

**요청 코드는 크롤러 화면처럼 나눈다.** `use-scheduler-manager.ts` 안의 인증 요청 함수를 `hooks/scheduler-manager-request.ts`로 옮겨 여러 hook 파일이 같이 쓴다(크롤러 쪽 `crawler-manager-request.ts`와 같은 모양, 제한 시간은 목록 30초와 실행 330초). 실행 기록 hook은 `hooks/use-scheduler-runs.ts`, 그룹 목록 hook은 `hooks/use-task-groups.ts`에 둔다. 단계 이름을 정하는 함수(지금 `StageCard.tsx`의 `resolveStageDisplayName`)는 단계 카드와 실행 기록이 같이 쓰도록 `components/schedulers/stage-display-name.ts`로 옮긴다.

**TES-197.** `deploy-web.yml`의 build env에 `VITE_SCHEDULER_MANAGER_WORKER_URL: ${{ vars.VITE_SCHEDULER_MANAGER_WORKER_URL }}`을 더한다. 저장소 GitHub 변수에는 이 이름이 아직 없다(2026-10-19 확인). 값은 `https://audio-underview-scheduler-manager-worker.tes-cha.workers.dev`다(운영 HELP 응답 200, 토큰 없는 `/task-groups`는 401로 확인). 변수는 PR에 push하기 전에 등록해야 preview build에도 들어간다.

## 3. 웹 (`applications/web`)

| 파일 | 할 일 |
| -- | -- |
| `hooks/scheduler-manager-request.ts` (새) | 인증 요청 함수, 오류 문구 읽기, 제한 시간 상수 |
| `hooks/use-scheduler-manager.ts` | 요청 함수를 새 파일에서 가져온다. `CreateStageInput`을 크롤러·그룹 두 모양으로, `UpdateStageInput`에 `fan_out_strategy`·`task_group_version`·`settings`를 더한다. `useListRuns`는 `use-scheduler-runs.ts`로 옮긴다 |
| `hooks/use-task-groups.ts` (새) | `useListTaskGroups()` |
| `hooks/use-scheduler-runs.ts` (새) | `useListRuns`(진행 중이면 5초마다), `useGetRun`(진행 중이면 5초마다), `useGetStageRun`, `useExecuteScheduler` |
| `components/schedulers/stage-display-name.ts` (새) | 단계 이름(카드와 실행 기록) |
| `components/schedulers/task-group-settings.ts` (새) | 설정 형식 → 입력 칸 목록, 입력 값 → 설정, 설정 → 입력 값. 화면 없는 함수 |
| `components/schedulers/TaskGroupSettingsFields.tsx` (새) | 입력 칸과 `Edit JSON` |
| `components/schedulers/CrawlerStageFields.tsx` (새) | 크롤러, 입력 형식(Simple mode·Edit JSON), fan-out 필드·방식. 지금 추가 대화상자의 칸을 옮긴 것 |
| `components/schedulers/StageCreateDialog.tsx` | 단계 종류 선택(`Crawler`·`Task group`)과 두 종류의 칸 |
| `components/schedulers/StageEditDialog.tsx` (새) | 종류는 바꾸지 않고 그 종류의 칸만. 바뀐 필드만 보낸다 |
| `components/schedulers/StageCard.tsx` | 고치기 버튼, `v<n> available` |
| `components/schedulers/StageList.tsx` | 고치기 대화상자 열기. 제목 줄에 바깥에서 넘긴 버튼(수동 실행)을 놓을 자리 |
| `components/schedulers/RunNowButton.tsx` (새) | 수동 실행 |
| `components/schedulers/RunHistorySection.tsx` | `Trigger` 칸, 펼친 회차의 단계 실행 목록 |
| `components/schedulers/StageRunList.tsx`, `StageRunDetail.tsx` (새) | 단계 실행 목록과 한 건의 입력·출력·파일·로그 |
| `pages/SchedulerDetailPage.tsx` | 수동 실행 버튼을 단계 목록 제목 줄에 넘기기, 실행 기록에 단계 목록과 크롤러 이름 넘기기 |

화면 문구는 영어이고 지금 화면의 말투를 따른다. 스타일은 지금 쓰는 styled 부품과 CSS 변수를 그대로 쓴다.

## 4. 테스트

기존 방식(브라우저 vitest, msw, `loadAuthenticationData` mock)을 따른다. 기존 테스트는 고치지 않고 통과해야 한다. 요청 함수를 옮기면서 import 경로가 바뀌는 곳만 고친다.

- **설정 함수.** 형식마다 맞는 칸이 나온다(`enum` → 선택, `string`, `number`·`integer`, `boolean`, 그 밖 → JSON). `title`·`description`·`required`·`default`가 칸에 들어간다. 최상위가 객체가 아니면 전체 JSON이다. 비운 칸은 빠지고, 숫자 칸과 JSON 칸의 잘못된 값은 오류로 돌려준다. 설정 → 입력 값 → 설정이 같은 값으로 돌아온다.
- **단계 추가.** 그룹이 없으면 `Task group`이 막히고 안내가 보인다. 그룹 목록 읽기가 실패해도 크롤러 단계는 추가된다. 그룹 단계를 추가하면 `POST` 본문이 `{ stage_type: 'task_group', task_group_id, task_group_version, settings, stage_order }`이고 기본 버전이 가장 높은 버전이다. 크롤러 단계 요청은 지금과 같다(fan-out 방식을 고르면 `fan_out_strategy`만 더해진다). 서버 `400` 문구가 toast로 보인다.
- **단계 고치기.** 크롤러 단계에서 바꾼 필드만 `PUT`에 들어간다. fan-out 필드를 비우면 `fan_out_field: null`이다. 바꾼 것이 없으면 요청하지 않는다. 그룹 단계에서 버전을 바꾸면 새 형식의 칸이 나오고 같은 이름의 값이 남으며, `PUT`이 `{ task_group_version, settings }`다. 크롤러 단계 대화상자에는 그룹 칸이, 그룹 단계에는 크롤러 칸이 없다.
- **단계 카드.** 고치기 버튼이 대화상자를 연다. 더 높은 버전이 있을 때만 `v<n> available`이 보인다.
- **수동 실행.** 단계가 없으면 막힌다. `200`이면 실행 기록을 다시 읽고 그 회차가 펼쳐진다. `202`면 진행 중으로 펼쳐진다. 실패 상태 코드라도 `run_id`가 있으면 회차가 펼쳐지고 오류 toast가 보인다. `409`는 `A run is already in progress`다. 요청 중에는 다시 누를 수 없다.
- **실행 기록.** `Trigger` 칸이 `Manual`·`Scheduled`다. 펼치면 단계 실행이 순서대로 나오고, fan-out 항목 수, 그룹 진행 상황, 오류가 보인다. 지운 단계는 `Stage <순서>`다. 단계 실행을 누르면 입력, 출력, 파일, 로그가 나오고, 잘린 로그면 안내가 보인다. 진행 중인 회차는 다시 읽어 상태가 바뀌고, 끝나면 더 읽지 않는다(시간은 테스트에서 줄여 확인한다).

## 5. 확인

- 루트 typecheck, 웹 test, 웹 build와 Storybook. 서버를 바꾸지 않지만 workspace 테스트도 지난번처럼 한 번씩 돌린다.
- `deploy-web.yml`의 env 줄은 눈으로 확인한다. preview build에 주소가 들어갔는지는 PR의 preview를 열어 개발자 도구로 `/schedulers` 요청이 scheduler 주소로 가는지 본다. preview에서는 로그인이 막혀 있어(TES-255) 요청이 401·CORS로 실패하는 것까지가 확인 범위다.

## 6. 하지 않는 것

- 디자인 변경(로그인·홈과 함께 나중에 다시 한다).
- 요일·시·분을 고르는 cron 입력 화면, 실행 취소, 실패한 단계만 다시 실행하기.
- 실제 작업 그룹(뉴스캐스트)과 그룹 등록 API.
- 편집 화면을 벗어날 때의 저장 확인(크롤러 화면에 남은 low와 같은 문제).
- `tools/environment-generator`의 scheduler 주소(그 도구 전체가 낡아 따로 정리한다).

## 7. 머지 전후

- migration이 없어 순서 문제가 없다. 머지하면 웹만 배포된다.
- GitHub 변수 `VITE_SCHEDULER_MANAGER_WORKER_URL`을 PR push 전에 등록한다. 없으면 preview와 운영 build 모두 지금처럼 주소 없이 만들어진다.
- 운영에서 볼 것: `/schedulers` 목록과 상세, 크롤러 단계 하나로 `Run now`, 실행 기록의 단계 실행과 로그. 그룹 단계는 등록된 그룹이 없어 운영에서 볼 수 없다.
