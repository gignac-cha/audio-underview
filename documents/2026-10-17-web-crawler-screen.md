# 웹 크롤러 화면 설계

작성일 2026-10-17. 기준 코드는 `main`(`3aeed6b`)이다. 범위는 2026-10-14에 정한 "웹 크롤러 화면"이다(Linear TES-249의 크롤러 부분). 이관이 아니라 메인에서 직접 만든다. 기능만 붙이고 디자인은 지금 그대로 둔다.

만들 것은 아래와 같다.
- 편집기의 시험 실행을 Lambda 직접 호출에서 crawler-manager로 옮긴다. 저장하지 않은 코드도 돌릴 수 있고, 코드는 1,048,576자까지다.
- 실행 결과의 로그와 파일을 보여 준다.
- 실행 기록(직접 실행과 시험 실행)을 보여 준다.
- 크롤러가 쓰는 환경 변수 이름을 선언하고, 계정의 환경 변수를 등록·변경·삭제하는 화면을 만든다.

고치는 곳은 `packages/supabase-connector`, `workers/crawler-manager-worker`, `applications/web`, `.github/workflows/deploy-web.yml`, `tools/environment-generator`, `documents`다. 새 npm 의존성은 없다. Lambda, scheduler-manager, user-vault는 바꾸지 않는다.

## 1. 결정

**시험 실행도 실행 기록에 남긴다** (사용자 결정 2026-10-16). 저장하지 않은 코드는 DB에 없으므로, 기록에 실행한 코드를 함께 저장한다. 새로 만드는 중이라 ID가 없는 크롤러의 시험 실행도 남는다.

**환경 변수는 계정 단위로 저장하고, 크롤러가 선언한 이름만 넘긴다** (2026-10-16 조사 뒤 결정). 조사한 서비스(GitHub Actions, n8n, Make, Pipedream, Val Town, Apify)는 값을 계정이나 팀 같은 위쪽에 한 번 저장하고, 쓰는 쪽이 필요한 것을 밝히거나 골라 받는다. 남이 만든 코드에는 사용자가 명시할 때만 넘긴다.
- 크롤러별로 저장하면 같은 키를 크롤러마다 넣어야 하고, 공유·공개되는 크롤러에 값을 둘 수 없다.
- 스케줄러별로 저장하면 편집기의 시험 실행과 직접 실행에 값이 없고, 구독한 남의 크롤러에 값이 넘어갈 수 있다.
- 크롤러는 `environment_variable_names`에 쓰는 이름을 적는다. 자기 크롤러를 실행할 때 계정의 환경 변수 중 이 이름들만 `context.environment`에 들어간다. 선언했지만 등록하지 않은 이름은 빠진다(오류가 아니다).
- 선언이 비어 있으면 vault를 부르지 않는다.
- isolate는 넘기는 환경 변수가 다르면 따로 쓴다. 같은 isolate의 전역 상태는 다음 실행까지 남으므로, 이전 실행에서 받은 값을 코드가 모듈 범위에 저장해 두면 선언을 지운 뒤의 실행에서도 그 값을 낼 수 있기 때문이다. 그래서 isolate ID에 넘기는 이름과 값의 digest를 넣는다(4절).
- 가리기는 vault를 불렀으면 vault가 돌려준 모든 값으로 하고, 부르지 않았으면 하지 않는다. vault를 부르지 않는 실행은 값을 받은 적 없는 isolate에서 돈다.
- 남의 크롤러(구독)와 시스템 크롤러에는 지금처럼 넘기지 않는다. 남의 크롤러에 사용자가 허락해 넘기는 것은 마켓플레이스 단위에서 정한다.
- 07 요구사항의 "그 사용자의 모든 크롤러가 쓸 수 있다"가 "크롤러가 선언한 이름만 쓸 수 있다"로 바뀐다. 운영에는 vault 시크릿이 없어(TES-143) 등록된 환경 변수가 없으므로, 기존 크롤러가 깨지지 않는다.

**환경 변수 화면은 계정 설정 페이지 `/settings`에 둔다.** 값이 계정 단위이기 때문이다. 상단 메뉴에 Settings를 더한다.

**편집기의 Run은 무엇을 돌리는지에 따라 경로를 고른다.**
- 저장된 크롤러를 고치지 않은 상태: `POST /crawlers/:id/runs`(직접 실행)
- 저장된 크롤러를 고친 상태: `POST /crawlers/:id/test-runs`(그 크롤러의 시험 실행)
- 새로 만드는 중: `POST /crawler-test-runs`(크롤러 없는 시험 실행)

## 2. 데이터 (migration 014)

`packages/supabase-connector/migrations/014_add_crawler_test_runs.sql`

```sql
ALTER TABLE crawlers
  ADD COLUMN environment_variable_names TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT crawlers_environment_variable_names_check
    CHECK (cardinality(environment_variable_names) <= 100);

ALTER TABLE crawler_runs
  ALTER COLUMN crawler_id DROP NOT NULL,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'test')),
  ADD COLUMN type TEXT CHECK (type IS NULL OR type IN ('web', 'data')),
  ADD COLUMN code TEXT,
  ADD CONSTRAINT crawler_runs_test_code_check CHECK ((kind = 'test') = (code IS NOT NULL)),
  ADD CONSTRAINT crawler_runs_direct_crawler_check CHECK (kind = 'test' OR crawler_id IS NOT NULL),
  ADD CONSTRAINT crawler_runs_test_type_check CHECK (kind = 'direct' OR type IS NOT NULL);

CREATE INDEX crawler_runs_user_uuid_unsaved_created_at_index
  ON crawler_runs (user_uuid, created_at DESC) WHERE crawler_id IS NULL;
```

- 이름 형식은 SQL에서 검사하지 않고 crawler-manager가 검사한다. 규칙은 환경 변수 API와 같은 `^[A-Z_][A-Z0-9_]{0,63}$`, 중복 없음, 100개까지다.
- 새로 남기는 행은 직접 실행이든 시험 실행이든 `type`을 채운다. 013의 기존 행은 `type`이 `null`이다.
- 크롤러를 지우면 그 크롤러의 기록(시험 실행 포함)도 지워진다(기존 cascade).
- 시험 실행의 코드도 보관 기한이 없다(사용량 제한 단위에서 정한다).
- 기존 코드는 새 스키마에서 그대로 동작한다. 새 컬럼에는 기본값이 있고, 바뀌는 것은 `NOT NULL`을 푸는 것뿐이다. 새 코드는 새 컬럼을 쓰므로 머지 전에 migration을 먼저 적용한다(9절).

## 3. connector (`packages/supabase-connector`)

타입 (`sources/types/database.ts`)
- `CrawlerRow`에 `environment_variable_names: string[]`. `crawlers`의 Insert와 Update에는 선택 항목으로 넣는다.
- `CrawlerRunKind = 'direct' | 'test'`
- `CrawlerRunRow`: `crawler_id: string | null`, `kind: CrawlerRunKind`, `type: CrawlerType | null`, `code: string | null`. Insert는 `crawler_id: string | null`, `kind?`, `type?`, `code?`.
- `CrawlerRunSummary = Pick<CrawlerRunRow, 'id' | 'crawler_id' | 'kind' | 'type' | 'status' | 'error_code' | 'logs_truncated' | 'started_at' | 'completed_at' | 'created_at'>`

함수
- `crawler-runs.ts`
  - `createCrawlerRun`: 새 컬럼을 받는다.
  - `listCrawlerRunsForUser(client, userUUID, { crawlerID, offset, limit }): Promise<{ data: CrawlerRunSummary[]; total: number }>`
    - `user_uuid = userUUID`이다. `crawlerID`가 문자열이면 `crawler_id = crawlerID`, `null`이면 `crawler_id IS NULL`로 거른다.
    - `created_at DESC, id DESC` 순서, `count: 'exact'`. 결과, 로그, 코드는 고르지 않는다.
  - `getCrawlerRunForUser(client, id, crawlerID, userUUID)`: `crawlerID`가 `string | null`이 된다. `null`이면 `crawler_id IS NULL`인 행을 찾는다.
- `crawlers.ts`: 생성과 수정이 `environment_variable_names`를 넘긴다(지금 다른 필드를 다루는 방식 그대로).
- 새 함수와 타입을 `index.ts`에서 export한다.

## 4. 실행 (crawler-manager)

`sources/crawler-runtime/run-crawler.ts`
- `runLoadedCrawler`가 받는 크롤러 타입을 넓힌다. `CrawlerRow`는 그대로 넘길 수 있다.

  ```ts
  export type RunnableCrawler = Pick<
    CrawlerRow,
    'user_uuid' | 'type' | 'code' | 'input_schema' | 'url_pattern' | 'environment_variable_names'
  > & { id: string | null };
  ```

- 환경 변수

  ```ts
  const ownsCrawler = context !== undefined && context.userUUID === crawler.user_uuid;
  // migration 014 전의 행에는 컬럼이 없다: 선언 없음으로 본다
  const declaredNames = crawler.environment_variable_names ?? [];
  // 선언이 없으면 vault를 부르지 않는다
  const variables = ownsCrawler && declaredNames.length > 0 ? await readEnvironment(...) : {};
  const environment = pickDeclared(variables, declaredNames);
  // vault가 돌려준 모든 값을 가린다
  const redactor = createRedactor(variables);
  ```

  `pickDeclared`는 선언한 이름 중 vault 응답에 있는 것만 담는다.
- isolate ID의 SHA-256 입력에 `environment`를 더한다. 이름순으로 정렬한 `[이름, 값]` 쌍의 JSON을 SHA-256한 hex를 코드 뒤에 `\0`으로 잇는다. 그래서 넘기는 이름이나 값이 하나라도 다르면 다른 isolate가 뜨고, 값을 받은 적 없는 실행(`{}`)은 값을 받은 적 없는 isolate에서만 돈다. 값 자체는 ID에 들어가지 않고 digest만 들어간다.
- `id`가 `null`이면 URL이 없을 때의 문구는 `Crawler test run: no URL available. Provide url in input or set a default in input_schema.`다. 로그 metadata의 `crawlerID`는 `null`이 된다.
- `CrawlerFileCapability`의 `crawlerID`가 `string | null`이 된다. `crawler_files.crawler_id`는 이미 `null`을 받는다.
- Lambda는 지금처럼 web 크롤러의 페이지 가져오기에만 쓴다.
- 스케줄러가 부르는 `runCrawler` RPC도 같은 `runLoadedCrawler`를 거치므로 선언 규칙이 그대로 적용된다. RPC 모양은 바뀌지 않는다.

## 5. API (crawler-manager)

모두 JWT(`authenticate`)가 필요하다. 오류 본문은 `{ error, error_description }`다. 새 route는 `routeCrawlerRuntime`에 더한다. `/crawlers/:id/test-runs`도 지금의 `parseCrawlerID` 분기보다 먼저 맞추고, `:id`가 UUID가 아니면 404 `Crawler not found`다. HELP 목록에 새 endpoint를 더한다.

### 크롤러 생성과 수정 — `POST /crawlers`, `PUT /crawlers/:id`

- `environment_variable_names`는 선택 항목이고, 문자열 배열이다.
  - 배열이 아니거나 항목이 문자열이 아니면 400 `Field 'environment_variable_names' must be an array of strings`
  - 이름이 틀리면 400 `Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$`(환경 변수 API와 같은 문구)
  - 중복이 있으면 400 `Field 'environment_variable_names' must not contain duplicates`
  - 100개를 넘으면 400 `Field 'environment_variable_names' must not exceed 100 names`
- 생성할 때 없으면 `[]`다. 수정할 때 없으면 그대로 둔다(`output_schema`와 같다).
- 응답의 크롤러 행에 들어간다.

### 직접 실행 — `POST /crawlers/:id/runs`

지금과 같다. 기록에 `kind = 'direct'`, `type = crawler.type`을 넣는다.

### 크롤러의 시험 실행 — `POST /crawlers/:id/test-runs`

- 자기 크롤러만 된다(`getCrawler(client, id, userUUID)`). 아니면 404 `Crawler not found`다.
- 본문은 JSON 객체로 꼭 있어야 한다: `{ code, url_pattern?, input_schema?, environment_variable_names?, input? }`. JSON이 아니면 400 `Request body must be valid JSON`, 객체가 아니면 400 `Request body must be a JSON object`다. 본문 검사는 크롤러 조회보다 먼저 한다.
  - `code`: 꼭 있어야 하고, 공백만이 아니며, 1,048,576자까지다. 문구는 크롤러 생성과 같다.
  - `url_pattern`: web일 때만 쓴다. 검사는 크롤러 생성과 같다. 없으면 저장된 값이다.
  - `input_schema`: data일 때만 쓰고, JSON 객체여야 한다. 없으면 저장된 값이다. web은 언제나 `{ body: 'string' }`이다.
  - `environment_variable_names`: 위 규칙과 같다. 없으면 저장된 값이다.
  - `input`: 있으면 그대로 쓰고, 없으면 `resolveDefaultInput(input_schema)`로 만든다(직접 실행과 같다). 던지면 400 `invalid_request`다.
  - 타입은 저장된 크롤러의 것이다. 편집기에서 바꿀 수 없다.
- 실행하는 크롤러는 저장된 크롤러에 본문 값을 덮은 것이다.
- 기록은 `kind = 'test'`, `crawler_id = id`, `type`, `code` = 실행한 코드다. 파일은 24시간 기한이고 `crawler_id = id`다.
- 응답과 상태는 직접 실행과 같다. 성공은 200, 실패는 `resolveDirectRunStatus`, vault를 읽지 못하면 503이다. 기록을 쓰지 못하면 `run_id`가 `null`이다.

### 크롤러 없는 시험 실행 — `POST /crawler-test-runs`

- 본문: `{ type, code, url_pattern?, input_schema?, environment_variable_names?, input? }`. 본문 오류 문구는 위와 같다.
  - `type`은 `'web'`이나 `'data'`로 꼭 있어야 한다. 틀리면 400 `Field 'type' must be 'web' or 'data'`다.
  - 없을 때의 값: `url_pattern`은 `null`(경고하지 않는다), `input_schema`는 web `{ body: 'string' }`·data `{}`, 이름 목록은 `[]`다.
- 실행하는 크롤러의 `id`는 `null`이고 `user_uuid`는 요청한 사용자다. 그래서 선언한 환경 변수가 넘어간다.
- 기록은 `kind = 'test'`, `crawler_id = null`이다. 파일은 24시간 기한이고 `crawler_id = null`이다.
- 응답은 위와 같다.

### 실행 기록 목록 — `GET /crawlers/:id/runs`, `GET /crawler-test-runs`

- `GET /crawlers/:id/runs`: 이 사용자가 이 크롤러로 한 실행(직접과 시험)이다. 자기 기록만 나오므로 크롤러 권한은 따로 보지 않는다.
- `GET /crawler-test-runs`: 이 사용자의 크롤러 없는 시험 실행이다.
- `offset`, `limit`은 `GET /crawlers`와 같은 검사, 문구, 기본값(0, 20, 최대 100)이다.
- 200 `{ data: CrawlerRunSummary[], total, offset, limit }`, 최신순이다.
- `/crawlers/:id/runs`와 `/crawler-test-runs`는 GET과 POST를 받고, 다른 메서드는 405 `Allow: GET, POST`다.

### 실행 기록 하나 — `GET /crawlers/:id/runs/:runID`, `GET /crawler-test-runs/:runID`

- `GET /crawlers/:id/runs/:runID`는 지금과 같다. 그 사용자의 그 크롤러 기록(이제 시험 실행 포함)만 200으로 행 전체(코드 포함)를 돌려준다. 아니면 404 `Crawler run not found`다.
- `GET /crawler-test-runs/:runID`는 `crawler_id IS NULL`인 그 사용자의 행이다. 아니면 404 `Crawler run not found`다.
- `:runID`가 UUID가 아니면 404 `Crawler run not found`다. GET이 아니면 405 `Allow: GET`다.

## 6. 웹 (`applications/web`)

지금 화면 구조와 스타일을 그대로 쓴다. 화면 문구는 지금처럼 영어다.

### 지우는 것

- `hooks/use-crawler-code-runner.ts`와 그 테스트, `schemas/crawler-code-runner.ts`와 그 테스트. 코드 길이 상수는 새 파일로 옮기고 값은 1,048,576이다.
- `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`: `schemas/environment.ts`, `vitest.config.ts`, `.github/workflows/deploy-web.yml`(웹 빌드 env), `tools/environment-generator`(웹 `.env` 생성 목록)에서 뺀다.

### API hooks

- `hooks/use-crawler-runs.ts`: 5절의 실행 API(직접 실행, 크롤러의 시험 실행, 크롤러 없는 시험 실행, 목록 둘, 상세 둘)와 파일 내려받기다.
  - 요청 방식(base URL, Bearer, 오류 문구)은 `use-crawler-manager.ts`를 따른다. 제한 시간은 목록과 상세가 30초, 실행은 crawler-manager의 마지막 제한(310초)보다 긴 330초다.
  - 실행 응답이 2xx가 아니어도 본문의 `status`가 `'failed'`면 실패 결과로 돌려준다(예외가 아니다). 그 밖의 2xx가 아닌 응답은 지금처럼 `error_description`으로 예외를 던진다.
  - 실행이 끝나면 해당 목록 query를 무효화한다.
- `hooks/use-environment-variables.ts`: 목록, 설정(PUT), 삭제다.
- 응답 형태는 `schemas/crawler-runs.ts`(zod)로 검사한다.
- `use-crawler-manager.ts`의 생성·수정 입력에 `environment_variable_names`를 더한다.

### 크롤러 편집 화면 (`pages/CrawlerEditorPage.tsx`)

- 코드 길이 표시의 한도를 1,048,576자로 바꾼다.
- Details에 **Environment variables**를 더한다. 이 크롤러가 쓰는 이름 목록이다.
  - 편집 모드에서 추가하고 지운다. 이름 규칙, 중복, 100개를 미리 검사한다.
  - 이름마다 계정에 등록됐는지(`GET /environment-variables`) 보여 주고, 없으면 "Not set"과 Settings 링크를 보인다. 이 링크는 새 탭으로 열어, 저장하지 않은 편집이 사라지지 않게 한다.
  - form 상태, dirty 판정, 저장 payload에 들어간다.
- Test Runner
  - 입력: web은 지금처럼 URL이고 `{ input: { url } }`로 보낸다. data는 JSON 입력란이고, 비우면 `input` 없이 보내 schema 기본값을 쓴다. JSON이 틀리면 요청하지 않고 입력란에 오류를 보인다.
  - Run은 1절 규칙으로 경로를 고른다. 시험 실행이면 무엇을 돌리는지(예: "Test run of unsaved changes") 패널에 보인다.
  - 결과: 지금의 `JSONResultPanel`을 쓴다. 실패면 `error`(코드)와 `error_description`을 보인다.
  - 로그: 크롤러 로그(레벨, 시각, 메시지)를 결과 아래에 보인다. `logs_truncated`면 잘렸다고 표시한다. 지금 client가 만드는 시작·성공·실패 줄은 없앤다. `LogOverlay`와 `StatusLogPanel`은 크롤러 로그 형식으로 바꿔 쓰고, 쓰지 않게 되면 지운다.
  - 파일: 결과 안의 파일 참조를 재귀로 찾아 목록으로 보인다. 파일 참조는 `file_id`가 UUID 문자열이고, `content_type`이 문자열, `size`가 숫자, `name`이 문자열이나 `null`인 객체다. 행마다 이름(없으면 `file_id`), 형식, 크기, Download 버튼이 있다.
    - Download는 `GET /files/:id`를 Bearer로 받아 blob으로 저장한다. 파일 이름은 참조의 `name`, 없으면 `file_id`다.
    - 404면 "File not found or expired"를 보인다.
  - Run history: 저장된 크롤러는 `GET /crawlers/:id/runs`, 새로 만드는 중이면 `GET /crawler-test-runs`를 보인다.
    - 행마다 종류(Direct, Test), 상태(실패면 `error_code`), 시작 시각, 걸린 시간을 보인다. 20개씩 받고 더 보기가 있다.
    - 행을 고르면 상세를 받아 결과, 로그, 파일을 실행 결과와 같은 자리에 보인다.

### 설정 화면 (`pages/SettingsPage.tsx`, route `/settings`)

- 다른 화면처럼 `ProtectedRoute` 안에 두고, 상단 메뉴(`NavigationLinks`)에 Settings를 더한다.
- Environment variables 섹션
  - 목록: 이름, 만든 시각, 바꾼 시각, 그리고 "n / 100".
  - 추가: 이름 입력, 값 password 입력(보기·가리기 토글), Add 버튼. 제출하는 순간 값 입력란을 비운다. 이미 있는 이름이면 추가하지 않고 Change value를 쓰라고 안내한다.
  - Change value: 행에서 값을 password 입력란으로 받고 Save와 Cancel이 있다. 제출하는 순간 입력란을 비운다.
  - Delete: 한 번 더 확인을 받는다.
  - 값은 어디에도 다시 보이지 않는다. 이름과 값 규칙(`^[A-Z_][A-Z0-9_]{0,63}$`, 4~16,384자)을 미리 검사한다.
  - 서버 오류는 `error_description`을 보인다. 409는 100개 한도이고, 503은 저장소를 쓸 수 없다는 뜻이다(운영은 TES-143 전까지 이 상태다).

## 7. 테스트

crawler-manager (`@cloudflare/vitest-plugin`, MSW)
- 생성과 수정의 `environment_variable_names` 검사와 저장. 생성의 기본값, 수정에서 빠졌을 때 유지.
- 실행
  - 선언한 이름만 `context.environment`에 들어간다.
  - 선언이 비면 vault를 부르지 않는다.
  - 남의 크롤러와 시스템 크롤러에는 선언이 있어도 넘기지 않는다.
  - 선언했지만 등록하지 않은 이름은 빠진다.
  - vault를 불렀으면 돌려준 모든 값을 가린다(넘기지 않은 값 포함).
  - 같은 코드라도 넘기는 이름이나 값이 다르면 다른 isolate에서 돈다. 모듈 범위에 값을 저장하는 코드를 `TOKEN`을 선언해 실행한 뒤, 선언을 지우고 다시 실행해도 그 값이 결과·오류·로그에 나오지 않는다.
  - migration 014 전처럼 `environment_variable_names`가 없는 행은 선언 없음으로 실행된다.
- `POST /crawlers/:id/test-runs`: 자기 크롤러만, 본문 덮어쓰기, 검사 문구, 기록(`kind`, `code`, `crawler_id`, `type`), 파일 기한, 응답 상태.
- `POST /crawler-test-runs`: `type` 필수, 빠진 값의 기본값, `crawler_id`가 `null`인 기록과 파일.
- 목록 둘: 자기 기록만, 크롤러로 거르기와 `null`로 거르기, 최신순, 요약 필드만(결과·로그·코드 없음), offset·limit 검사, 405.
- 상세 둘: 남의 기록, 다른 크롤러의 기록, `crawler_id`가 있고 없음이 다르면 404.
- 직접 실행 기록에 `kind = 'direct'`와 `type`이 들어간다.

connector
- 새 함수와 바뀐 함수를 기존 테스트 방식으로 확인한다.

web (Vitest browser mode, MSW `worker.use`)
- hooks: 각 요청의 경로·메서드·본문, 실패 결과와 예외의 구분, 목록 무효화.
- 편집 화면
  - 세 경로 고르기
  - data 입력과 잘못된 JSON
  - 로그와 잘림 표시
  - 파일 찾기와 내려받기
  - 실행 기록과 상세
  - 환경 변수 선언과 "Not set"
- 설정 화면: 목록, 추가 검사와 값 입력란 비우기, 값 변경, 삭제 확인, 409와 503.

테스트 파일은 tsconfig(`sources/**`)에 없어 `pnpm typecheck`가 잡지 않는다. 임시 tsconfig에 새로 만들거나 바꾼 테스트 파일을 넣어 따로 확인한다.

## 8. 하지 않는 것

| 항목 | 이유 | 이어 붙일 단위 |
| -- | -- | -- |
| 남의 크롤러에 내 환경 변수를 허락해 넘기기 | 크롤러 작성자가 외부 요청으로 값을 가져갈 수 있어 사용자 동의 절차가 필요하다 | 마켓플레이스 |
| 스케줄별로 다른 값 | 지금은 이름을 다르게 붙이면 된다(예: `BLOG_A_TOKEN`) | 필요해지면 |
| 실행 기록과 시험 실행 코드의 보관 기한 | 요구사항에서 사용량 제한으로 미뤘다 | 사용량 제한 |
| 새로 만들기에서 data 크롤러 고르기 | 지금 화면에 없다 | 필요해지면 |
| 디자인 | 로그인·홈과 함께 다시 한다 | 재디자인 |

## 9. 머지 전후

- 머지 전에 migration 014를 운영 DB에 먼저 적용한다. 기존 코드는 새 스키마에서도 동작하고, 새 코드는 새 컬럼이 있어야 동작한다.
- GitHub 변수 `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL`은 웹에서 더 쓰지 않는다. 지우는 것은 사람 몫이고 선택이다.
- 운영에서 환경 변수 등록은 TES-143 전까지 503이다(07과 같다).
