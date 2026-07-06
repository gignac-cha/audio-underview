# Web Application — 기능/UX 완전 스펙 (재작성 기준 문서)

> 대상: `applications/web/sources/` (2026-07-06, branch `main` 기준 9,284 lines)
> 목적: UI 전면 재디자인 시에도 **보존해야 할 기능적 행위와 사용자 플로우**를 명세.
> 픽셀/스타일 디테일은 의도적으로 제외. 코드 인용은 행위 근거가 필요한 곳만.

---

## 1. 사용자 플로우 (End-to-End Journey)

```
[미인증 진입]
  / ──(RootRedirect)──> /sign/in
  /sign/in: 8개 OAuth provider 버튼 (Google/GitHub만 실동작)
    └─ 클릭 → {OAuth Worker}/authorize?redirect_uri={origin}/authentication/callback 로 전체 리다이렉트
  /authentication/callback:
    └─ query 검증 → user JSON zod 검증 → crawler-manager 워커에 access_token 교환(자체 JWT 발급)
       → localStorage 저장 → /home (실패 시 error toast + /sign/in)

[인증 후]
  /home: 환영 카드 (avatar, name, email)
  상단 GNB: Home / Crawlers / Schedulers + Sign Out (모든 보호 페이지 공통)

[크롤러 작성/실행]
  /crawlers: 목록(무한 페이지네이션) → "New Crawler" → /crawlers/new
  /crawlers/new (create mode): 이름 + Monaco 코드 작성 → Submit → 생성 후 /crawlers/{id} 이동
  /crawlers/{id} (view mode): 읽기 전용 + 선택적 Test 패널
    └─ Edit (⌘E) → edit mode → 수정 → Save (⌘S) → view 복귀
    └─ Test 패널: URL 입력 → Run (⌘↵) → JSON 결과 + 실행 로그 오버레이

[스케줄러 구성]
  /schedulers: 목록 → "New Scheduler" dialog (name, cron 선택 입력, enabled)
    → 생성 성공 시 /schedulers/{id} 이동
  /schedulers/{id}:
    ├─ 인라인 편집: name(클릭→input), cron(클릭→input), enabled(toggle switch)
    ├─ Pipeline Stages: "Add Stage" dialog (crawler 선택 + input schema + fan-out)
    │   drag&drop 재정렬 (optimistic + 실패 시 rollback)
    └─ Run History: 실행 이력 테이블 (행 클릭 → error/result 상세 확장)

[로그아웃]
  Sign Out → localStorage 제거 + React Query cache 전체 clear → guard가 /sign/in 으로 밀어냄
```

---

## 2. 라우트 및 Guard

`sources/Application.tsx` — `react-router` v7 `BrowserRouter` + `<Routes>` 선언.

| Path | Page | Guard | 비고 |
|---|---|---|---|
| `/` | `RootRedirect` | — | isLoading → "Loading..." / 인증 → `/home` / 미인증 → `/sign/in` (모두 `replace`) |
| `/sign/in` | `SignInPage` | 역guard | 이미 인증 시 `/home` replace |
| `/authentication/callback` | `AuthenticationCallbackPage` | — | OAuth 콜백 전용 |
| `/home` | `HomePage` | `ProtectedRoute` | |
| `/crawlers` | `CrawlersPage` | `ProtectedRoute` | |
| `/crawlers/:id` | `CrawlerEditorPage` | `ProtectedRoute` | **`id === 'new'` 이면 create mode** — new/detail 단일 라우트 통합 |
| `/schedulers` | `SchedulersPage` | `ProtectedRoute` | |
| `/schedulers/:id` | `SchedulerDetailPage` | `ProtectedRoute` | |

**ProtectedRoute** (`components/ProtectedRoute.tsx`): `isLoading` → 로딩 표시, 미인증 → `/sign/in` replace, 인증 → children. (현재 `isLoading`은 항상 `false` — §6 참고)

**Provider 트리** (`main.tsx`):
`StrictMode > QueryClientProvider(staleTime 5분, retry 1) > ToastProvider > Application(BrowserRouter > AuthenticationProvider > Routes)`
- 부팅 시 `validateEnvironment()` 실행 — env 스키마 실패 시 앱이 throw로 기동 중단.
- `LoggerProvider`는 **앱 트리에 마운트되어 있지 않음** (§6).

---

## 3. 인증 (Authentication)

### 3.1 로그인 시작 — SignInPage
- `ENABLED_PROVIDERS` 8종: google, apple, microsoft, facebook, github, discord, kakao, naver.
- **실동작은 Google/GitHub만**: `loginWithGoogle()` / `loginWithGitHub()` → `{workerURL}/authorize?redirect_uri={origin}/authentication/callback` 로 `window.location.href` 리다이렉트.
- 나머지 provider 클릭 → info toast `"{provider} 로그인 / 아직 구현되지 않았습니다."`
- Worker URL 미설정 시 error 콜백 (`onGoogleError`/`onGitHubError`) — SignInPage에서는 error toast.
- FontAwesome brand 아이콘 / SVG path / 텍스트 이니셜 3단 fallback으로 provider 아이콘 렌더.

### 3.2 콜백 처리 — AuthenticationCallbackPage
순서 (모든 실패는 error toast `로그인 실패` + `/sign/in` replace):
1. re-entrancy 방지 (`processingRef`).
2. `?error` 존재 → `error_description` 토스트 후 이탈.
3. `?user`(URI-encoded JSON) + `?access_token` 필수.
4. user를 zod 스키마 검증 (id/email/name/picture?/provider enum/uuid?).
5. **토큰 교환**: `POST {VITE_CRAWLER_MANAGER_WORKER_URL}/authentication/token` body `{provider, access_token}` (timeout 10s) → `{token, expires_in}` 자체 발급 JWT 수신.
6. `loginWithProvider(provider, user, token, expires_in*1000)` → localStorage 저장 성공 시 `/home` replace.
- 처리 중 스피너 + `로그인 처리 중...` 표시.

### 3.3 세션 — AuthenticationContext
- 저장소: `localStorage['sign-provider-auth']` (`@audio-underview/sign-provider`의 `createStoredAuthenticationData`; user + credential + 만료).
- 기본 세션 24h; 콜백에서는 서버 `expires_in` 우선.
- 초기 마운트 시 lazy state로 복원 — 만료/파손 데이터는 즉시 제거.
- `logout()`: localStorage 제거 + `queryClient.clear()` + user 초기화.
- Context value: `user, isAuthenticated, isLoading(항상 false), enabledProviders, isGoogleConfigured, isGitHubConfigured, loginWithGoogle, loginWithGitHub, loginWithProvider, logout`.
- API 호출용 토큰은 context가 아니라 각 훅에서 `loadAuthenticationData().credential` 직접 로드 (§8).

---

## 4. 페이지별 기능 명세

### 4.1 HomePage (117줄)
- 공통 Header(GNB + Sign Out) + 환영 카드: `Welcome, {name}!`, avatar(large), name, email.
- 데이터 로딩 없음. 순수 표시.

### 4.2 CrawlersPage (463줄)
- 데이터: `useListCrawlers()` — infinite query, page size 20, "Load More" 버튼.
- 상태 분기: loading 스피너 / error("Failed to load crawlers." + Retry refetch) / empty(스파이더 아이콘 + "No crawlers yet. Create your first one!" + New 버튼) / 목록.
- 카드: name, url_pattern, `Created {date}`. 카드 전체가 클릭 타겟(`role="button"`, Enter/Space 키 지원) → `/crawlers/{id}`.
- 카드 우측 휴지통: `stopPropagation` 후 **삭제 확인 모달** (자체 구현 overlay+modal, Radix 아님) — "This action cannot be undone", Cancel autoFocus, Escape 닫기. 확정 시 `deleteCrawler` → success/error toast.
- "New Crawler" → `navigate('/crawlers/new')` (목록 상단 TopBar와 empty state 두 곳).

### 4.3 CrawlerEditorPage (831줄) — 핵심 페이지

#### 4.3.1 new/detail 통합 구조
- `useParams().id === 'new'` → create mode. 상세와 동일 컴포넌트/레이아웃 사용.
- `<CrawlerEditorPageContent key={id ?? 'new'} />` — **id 변경 시 key로 전체 상태 강제 리셋** (create → 생성 후 detail 이동 시 잔여 상태 제거).
- 모드 3종 (`useEditorMode`): `create` / `view` / `edit`. `isEditable = create || edit`.

#### 4.3.2 레이아웃 (split-pane)
- 상단: 공통 Header(GNB+Sign Out) 아래 TopBar.
  - 좌: Back 버튼(→ /crawlers, dirty guard 적용), 제목(create: "New Crawler", 그 외 form.name), **Mode 뱃지**(Create/Edit/View), dirty 시 "Unsaved" 인디케이터(aria-live).
  - 우(모드별):
    - view: `Show Test`/`Hide Test` 토글 + `Edit`(⌘E 힌트)
    - create: `Submit`(⌘S 힌트, `aria-disabled` + title/VisuallyHidden으로 disabledReason 노출)
    - edit: `Cancel` + `Save`(⌘S 힌트, 동일 disabledReason 패턴)
- 본문: CSS Grid — Test 패널 표시 시 2컬럼(1fr 1fr, 240ms transition), 숨김 시 1컬럼. `@media (max-width: 900px)` 1컬럼 강제.
- 좌측 FormColumn 섹션: **Details / Code / Input schema / Output schema** (schema 두 섹션은 create mode에서는 미표시).
- 우측 TestColumn 섹션: **Test Runner / Result**.

#### 4.3.3 Test 패널 표시 규칙
- `mode === 'view'`: 사용자 토글, 상태를 `localStorage['crawler-editor:test-panel-open']`에 `'open'|'closed'` 로 영속.
- `mode === 'edit' | 'create'`: **항상 표시** (토글 불가).

#### 4.3.4 Details 섹션
- 편집 가능 시: name input (모드 진입 시 autofocus).
- Type 뱃지: `crawler.type ?? 'web'` (`web` | `data`).
- `web` 타입만 URL pattern 필드 (편집 시 input, view 시 읽기 값). placeholder `^https://example\.com`.
- 상세 모드에서 Created/Updated 일시 표시.

#### 4.3.5 Code 섹션 — Monaco 설정
- `@monaco-editor/react` `<Editor>`: `defaultLanguage="javascript"`, `theme="vs-dark"`, `minimap off`, `fontSize 13`, mono 폰트 스택, `lineNumbers on`, `scrollBeyondLastLine false`, `readOnly = !isEditable || isSaving`, `padding top 12`, `wordWrap on`, `automaticLayout true`, `height 100%`.
- create mode에서 빈 값이면 DEFAULT_CODE 템플릿 표시:
  ```javascript
  // Write a function that receives the page body as a string
  // and returns the extracted data.
  (body) => {
    return body.length;
  }
  ```
- 헤더에 문자 수 카운터 `{length} / 10,000` — `MAX_CODE_LENGTH`(10,000) 초과 시 error 색.

#### 4.3.6 Schema 섹션 (detail 전용)
- input/output 각각 textarea (JSON pretty-print 2-space seed).
- **web 타입: input schema 읽기 전용 고정** — helper "Web crawlers receive the fetched page body — schema is fixed and not editable."
- data 타입 input + 전 타입 output: 편집 가능, `onBlur` 시 검증 — JSON **object**(배열/원시 불가)가 아니면 인라인 error "Must be a valid JSON object." + `aria-invalid`.
- 타이핑 중에는 기존 error가 있고 값이 유효해지면 즉시 error 해제 (`changeSchema`).

#### 4.3.7 폼 상태 / dirty / 저장 (useCrawlerEditor + useCrawlerForm)
- FormState 5필드: `name, url_pattern, code, input_schema, output_schema`. `pristine` 스냅샷과 필드별 비교로 `isDirty`.
- 서버 데이터 도착 시 crawler.id 단위로 1회 seed (`resetFromCrawler`) + edit 해제 — 렌더 중 조건부 setState 패턴.
- `canSubmit`: form 존재 ∧ (create ∨ dirty) ∧ schema error 없음 ∧ name.trim() 비지 않음 ∧ code.trim() 비지 않음 ∧ (data ∨ url_pattern.trim() 비지 않음).
- `disabledReason` 우선순위 메시지: "No changes to save." → "Fix schema errors before saving." → "Name is required." → "Code cannot be empty." → "URL pattern is required for web crawlers."
- **save()** (in-flight ref로 중복 방지):
  1. schema 2필드 JSON object 파싱 실패 시 해당 필드 error 세팅 + error toast 후 중단.
  2. name/code/(web)url_pattern 공백 검증 + error toast.
  3. create: `POST /crawlers {name, url_pattern, code}` → success toast `Crawler "{name}" has been created.` → `/crawlers/{created.id}` 이동.
  4. update: 타입별 payload — data: `{type:'data', name, code, input_schema, output_schema}` / web: `{type:'web', name, url_pattern, code, output_schema}` → `markSaved`: **저장 중 사용자가 추가 입력했으면 서버 응답으로 덮어쓰지 않음** (제출 시점 form 객체 동일성 비교; 동일할 때만 view 복귀) → success toast `... has been updated.`
  5. 실패: error toast (서버 message), edit mode 유지.

#### 4.3.8 이탈 보호
- `useBeforeUnload(isEditable && isDirty)`: 브라우저 새로고침/탭닫기 시 native beforeunload 경고.
- **DiscardDialog** (Radix AlertDialog 패턴): Cancel 버튼/Back 버튼이 dirty 상태일 때 열림 — "Discard unsaved changes?" / "You have unsaved changes. If you leave now, they will be lost." / `Keep editing`(autoFocus) vs `Discard`.
  - Cancel(edit): confirm 시 pristine 복원 + view 복귀. create에서는 `/crawlers` 이동.
  - Back: confirm 시 `/crawlers` 이동.
  - dirty 아니면 dialog 없이 즉시 실행.
- SPA 내 라우팅 차단(GNB 링크 등)은 **미구현** — beforeunload는 브라우저 이탈만 커버 (§10 개선 후보).

#### 4.3.9 키보드 단축키 (document keydown, Mac은 ⌘/그 외 Ctrl)
| Key | 조건 | 동작 |
|---|---|---|
| Mod+S | isEditable | save (canSubmit && !isSaving 일 때만) — preventDefault |
| Mod+E | view mode ∧ 포커스가 form 요소(input/textarea/select/contentEditable)가 아닐 것 | enterEdit |
| Mod+Enter | Test 패널 표시 ∧ URL 있음 ∧ 미실행 | Run test |
- 버튼에 `⌘+S` 등 ShortcutHint 라벨 표시. `useEffectEvent`로 최신 상태 참조.

#### 4.3.10 Test Runner (useCrawlerCodeRunner)
- URLInputPanel: `type="url"`, placeholder `https://example.com`, 값이 있고 `new URL()` 파싱 실패 시 invalid 스타일. 실행 중 disabled.
- Run 버튼: URL 없거나 실행 중이면 disabled, 실행 중 라벨 "Running…".
- 요청: `POST {VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL}/run` body `{type:'test', url, code}` — **Authorization 헤더 없음**(공개 함수 엔드포인트), 30s AbortController timeout.
- 응답: zod 검증 — 성공 `{type, result}` / 실패 `{error, error_description}` → `Error("{error}: {error_description}")`, 파싱 불가 시 `Request failed with status {n}`.
- **draft 실행**: 현재 form.code를 그대로 전송 — 편집 중이면 저장 안 된 코드로 테스트. dirty ∧ editable 시 Test Runner 제목 옆 "· running draft" 힌트.
- 실행 로그(LogEntry: id/timestamp/level info|success|error/message/details?): mutation 수명주기에서 자동 발행 — "Starting test execution..." → "Fetching {url}" → "Execution completed successfully" | "Execution failed"(details=message). 로그는 페이지 state에 누적 (실행 간 리셋 없음, Clear 버튼으로만 비움).

#### 4.3.11 JSONResultPanel
- 상태별: idle "Run a test to see results here." / running 스피너+"Executing..." / error `error.message` / success JSON 트리.
- JSON 렌더: key/string/number/boolean/null/punctuation 색상 구분, 재귀 렌더 max depth 20 ("[max depth reached]"), 문자열 500자 truncate(+"...").
- success 시 Copy 버튼 → `navigator.clipboard.writeText(JSON.stringify(result, null, 2))` → "Copied!" 2초 표시. 클립보드 실패는 무시.

#### 4.3.12 LogOverlay + StatusLogPanel
- 헤더의 `Logs ({count})` 버튼 → Radix Dialog 오버레이 "Status Log".
- StatusLogPanel: 엔트리 없으면 "No logs yet.", 있으면 `[HH:MM:SS] message (details)` — level별 색, 새 엔트리 추가 시 하단 자동 smooth 스크롤.
- 엔트리 있으면 Clear 버튼(로그 비움). 닫기 X. aria-live로 로그 개수 안내.

#### 4.3.13 로딩/에러
- detail 로딩: 스피너 (aria-live "Loading crawler details").
- GET 실패: "Failed to load crawler." + Retry(refetch).

### 4.4 SchedulersPage (475줄)
- CrawlersPage와 동형 패턴 (loading/error+Retry/empty/list + Load More, page size 20).
- 카드: name, `cron_expression ?? 'Manual only'`, Enabled/Disabled 뱃지(check/ban 아이콘), Created 날짜, 삭제 버튼.
- 삭제 확인 모달 문구에 **cascade 경고**: "This will also delete all stages and run history."
- "New Scheduler" → **SchedulerCreateDialog** (Radix Dialog):
  - 필드: Name(필수, autoFocus), Cron Expression(선택, placeholder `0 9 * * *`), Enabled 체크박스(기본 true).
  - form submit(Enter 포함) → name 공백이면 error toast. 성공 시 success toast + dialog 리셋/닫기 + `/schedulers/{id}` 이동.
  - 제출 중 dialog 닫기 차단, 입력 disabled, 스피너+"Creating...".
  - cron 미입력 시 `cron_expression` 미전송(수동 실행 전용 스케줄러).

### 4.5 SchedulerDetailPage (184줄)
- 병렬 로딩 3종: `useGetScheduler(id)`, `useListStages(id)`, `useListCrawlers()`(stage 카드에 crawler 이름 매핑용 Map 구성).
- Back to Schedulers 버튼(guard 없음 — 인라인 편집은 즉시 저장이므로 dirty 개념 없음).
- scheduler 에러/stages·crawlers 에러 각각 별도 error state + 부분 Retry(실패한 쿼리만 refetch).
- 구성: SchedulerInfoSection → StageList → RunHistorySection.

#### 4.5.1 SchedulerInfoSection — 인라인 편집
- **Name**: 텍스트 클릭(또는 Enter/Space) → input 전환(autoFocus). blur/Enter commit — trim 후 변경 시에만 `PUT`; Escape 취소. 빈 값이면 원복.
- **Cron**: 동일 패턴. 빈 값 commit 시 `cron_expression: null` (→ "Manual only").
- **Enabled**: toggle switch (`role="switch"`, aria-checked) — 클릭 즉시 `PUT {is_enabled: !current}`.
- 각 필드 저장은 optimistic 아님 — mutation 성공 시 detail 캐시 갱신으로 반영, 실패 시 error toast.
- 표시: Last Run(`last_run_at` 없으면 "Never"), Created.

#### 4.5.2 StageList — 파이프라인 스테이지 (@dnd-kit)
- 세로 목록, 스테이지 사이 ↓ 화살표 커넥터 (파이프라인 시각화).
- DnD: `DndContext(closestCenter)` + `SortableContext(verticalListSortingStrategy)`.
  - `PointerSensor` activation distance 5px(클릭과 드래그 구분), `KeyboardSensor(sortableKeyboardCoordinates)` — 키보드 재정렬 지원.
- **Optimistic reorder**: drop 시 `arrayMove` + `stage_order` 0-based 재부여 → 화면 즉시 반영 → `PUT /schedulers/{id}/stages/reorder {stage_ids}` → 실패 시 서버 상태로 rollback + error toast. 재정렬 진행 중 추가 드래그 무시.
  - props로 온 서버 stages가 바뀌면 optimistic 상태 폐기(서버 우선) — useReducer + 참조 비교.
- 빈 상태: "No stages yet. Add your first crawler to the pipeline."
- "Add Stage" → StageCreateDialog. `nextOrder = 현재 stage 수`.

#### 4.5.3 StageCard
- 드래그 핸들(grip 아이콘, dnd attributes/listeners는 핸들에만), 드래그 중 opacity 0.5.
- stage_order 뱃지, crawler 이름(crawlerMap 조회 실패 시 `crawler_id 앞 8자 + '...'`), `fan_out_field` 있으면 branch 아이콘 뱃지.
- 삭제 버튼: **확인 없이 즉시 삭제** → success/error toast (§10 개선 후보).

#### 4.5.4 StageCreateDialog (429줄)
- Crawler select: `{name} ({type})` 옵션, 목록 페이지네이션 "Load more crawlers".
- Crawler 선택 시 input schema 초기화 (`buildDefaultSchema`): web → `{url: {type:'string', default:''}}` / data → crawler의 input_schema(비어 있으면 `{}`).
- **Input Schema 이중 모드** ("Edit JSON" ↔ "Simple mode" 토글):
  - Simple + web: Default URL 텍스트 입력 → `{url:{type:'string', default: url}}` 로 변환 제출.
  - Simple + data: JSON textarea (prefill).
  - JSON 모드: raw textarea — 제출 시 파싱 실패면 error toast "Invalid JSON in input schema."
- Fan-out Field(선택): trim 후 비면 미전송.
- 제출: crawler 미선택 시 error toast. 성공 → "Stage added to pipeline." + dialog 전체 리셋/닫기. 제출 중 닫기 차단.

#### 4.5.5 RunHistorySection
- `useListRuns(schedulerID)` infinite query (20/page). 로딩 중엔 섹션 자체 미표시.
- 테이블 3컬럼: Status(RunStatusBadge) / Started(월·일·시·분) / Duration(`completed_at - started_at` → ms/s/`Xm Ys`; 미완료 "-").
- 행 클릭(또는 Enter/Space, aria-expanded) → 확장 영역 토글(1개만 유지): `run.error` pre / `run.result` JSON pre / 둘 다 없으면 "No additional details."
- RunStatusBadge 5상태: pending(회색)/running(파랑)/completed(초록)/failed(빨강)/partially_failed(주황 "Partial") — 색 dot + 라벨.
- empty: "No runs yet." / error: "Failed to load run history: {message}". Load More 페이지네이션.
- **UI에서 run 수동 트리거 기능 없음** — cron 또는 외부 트리거 전제 (§10).

---

## 5. 컴포넌트/훅 책임 인벤토리

### 공용 컴포넌트 (`components/`)
| 파일 | 책임 |
|---|---|
| `ProtectedRoute.tsx` | 인증 guard. 미인증 `/sign/in` replace |
| `NavigationLinks.tsx` | GNB 3링크(Home/Crawlers/Schedulers) — `NavLink` active 상태, 아이콘+라벨 |
| `PageHeader.tsx` | 컴포넌트 아님 — styled export만 (`Header`, `LogoutButton`, `UserSection`). 각 페이지가 헤더 JSX를 **복붙 조립** (§10) |
| `SignInButtons.tsx` | provider 버튼 목록. google/github → context 로그인, 그 외 `onProviderClick` 위임. inline style 기반 (Emotion 미사용 예외) |
| `UserAvatar.tsx` | Radix Avatar. 이미지 실패 시 이름 이니셜 fallback. default(36px)/large(80px) |
| `DiscardDialog.tsx` | 재사용 confirm(alertdialog). 문구/라벨 props 커스텀 가능, 기본은 unsaved-changes 문구 |

### crawlers/ — §4.3에 상술: `CodeEditorPanel`(Monaco+카운터), `URLInputPanel`, `JSONResultPanel`, `StatusLogPanel`, `LogOverlay`
### schedulers/ — §4.4–4.5에 상술: `SchedulerCreateDialog`, `SchedulerInfoSection`, `StageList`, `StageCard`, `StageCreateDialog`, `RunHistorySection`, `RunStatusBadge`

### Hooks (`hooks/`, 11개 + 헬퍼 모듈)
| 훅 | 책임 |
|---|---|
| `use-authentication.ts` | AuthenticationContext consumer (미제공 시 throw) |
| `use-toast.ts` | ToastContext consumer (미제공 시 throw) |
| `use-logger.ts` | LoggerContext consumer + `createWebLogger` 팩토리/`webLogger` 싱글턴. **앱에서 실사용 없음** |
| `use-media-query.ts` | `matchMedia` + `useSyncExternalStore`. **앱에서 실사용 없음** (반응형은 CSS @media로만) |
| `use-before-unload.ts` | enabled 시 beforeunload preventDefault |
| `use-editor-mode.ts` | create/view/edit 모드 상태 머신 (enterEdit/exitEdit) |
| `use-crawler-form.ts` | form/pristine/isDirty/schemaErrors + reset/markSaved/validate/changeSchema |
| `crawler-form-helpers.ts` | FormState 타입, BLANK_FORM, deriveFormState, tryParseSchema(JSON object만 허용), computeIsDirty |
| `use-crawler-editor.ts` | 에디터 오케스트레이터: 위 훅들 + manager 훅 + dirty-guard/discard dialog + save 파이프라인 + disabledReason |
| `use-crawler-code-runner.ts` | 테스트 실행 mutation + 로그 발행. status를 `pending→'running'` 으로 리매핑 |
| `use-crawler-manager.ts` | crawler CRUD 5훅 (create/list∞/get/update/delete) — fetch + query key + invalidation |
| `use-scheduler-manager.ts` | scheduler CRUD 5훅 + stage 4훅(list/create/update/reorder/delete) + runs list∞ — 공용 `authenticatedFetch` 헬퍼 |

### Contexts (`contexts/`)
| Context | 책임 | 마운트 |
|---|---|---|
| `AuthenticationContext` | 세션 저장/복원/로그인 리다이렉트/로그아웃 (§3.3) | O (Application) |
| `ToastContext` | Radix Toast 큐. `showToast(title, desc?, type)` + `showError`/`showSuccess`. type별 좌측 보더 색, swipe-right dismiss, X 닫기 | O (main) |
| `LoggerContext` | `@audio-underview/logger` browser logger 제공 | **X — 미마운트.** 페이지들은 `createBrowserLogger` 직접 생성 (AuthenticationContext, CallbackPage) |

---

## 6. 상태관리 실태 (재작성 시 단일화 근거)

**결정적 사실: `zustand`(5.0.11) / `recoil`(0.7.7) / `jotai`(2.17.1) 셋 모두 `package.json` dependencies에 있으나, `sources/` 전체에서 import가 단 한 건도 없음** (`grep -rln 'zustand|recoil|jotai' sources` → 0건; `useAtom|useRecoil|useStore` 등 API 호출도 0건).

실제 상태관리 구성:
| 레이어 | 도구 | 사용처 |
|---|---|---|
| 서버 상태 | TanStack Query v5 | crawler/scheduler/stage/run 전체 CRUD (§8) |
| 전역 클라이언트 상태 | React Context ×3 | Authentication / Toast / (Logger 미사용) |
| 지역 상태 | `useState`/`useReducer`/`useRef` | 폼, dialog open, 확장 행, optimistic reorder(useReducer) 등 |
| 영속 상태 | `localStorage` 직접 | 세션(`sign-provider-auth`), test 패널(`crawler-editor:test-panel-open`) |

→ 재작성 시: **recoil/zustand는 dependency 제거만으로 정리 완료** (마이그레이션 비용 0). Jotai 단일화는 "이전"이 아니라 그린필드 도입이며, 현 규모에선 Context 3개 + Query로 충분하다는 점도 판단 재료. Recoil은 이미 archived 라이브러리라 제거 필수.

---

## 7. 스타일링 실태

- **Emotion** (`@emotion/styled` + `keyframes`): 23개 파일 — 페이지/컴포넌트 전부. styled-component가 각 파일 상단에 대량 선언되어 파일 길이의 30–50% 차지 (831줄 페이지의 주 원인 중 하나).
- **Radix UI 실사용 4패키지**: `react-avatar`(UserAvatar), `react-dialog`(DiscardDialog/LogOverlay/SchedulerCreateDialog/StageCreateDialog), `react-toast`(ToastContext). **미사용 설치 패키지**: `react-dropdown-menu`, `react-navigation-menu`, `react-popover`, `react-slot` → 제거 대상.
- **SCSS**: `styles/global.scss` 단 1개 — CSS 변수 팔레트(다크), reset, 링크/버튼 기본, `.loading-container` 유틸. SCSS 문법은 `&:hover` 중첩 1곳뿐 → 사실상 plain CSS.
- **다크모드**: **다크 단일 테마 고정.** `prefers-color-scheme`/`data-theme`/라이트 팔레트 없음. Monaco도 `vs-dark` 하드코딩.
- **반응형**: CSS `@media` 소수 (에디터 grid 900px 브레이크포인트 등). `useMediaQuery` 훅은 미사용. 모바일 대응은 사실상 미설계.
- **아이콘**: FontAwesome (solid + brands). **디자인 토큰**: CSS 변수 (`--bg-*, --accent-*, --text-*, --border-*, --color-error/success, --font-mono, --shadow-*, --transition-fast`).
- 예외: `SignInButtons`/`AuthenticationCallbackPage`는 inline style 사용 (스타일 방식 3종 혼재: Emotion / inline / global class).

---

## 8. API 호출 계층

### 8.1 환경변수 (worker URL 구성) — `schemas/environment.ts`
| 변수 | 용도 | 필수 |
|---|---|---|
| `VITE_GOOGLE_CLIENT_ID` | (legacy — worker redirect 전환 후 제거 예정 TODO) | O |
| `VITE_GOOGLE_OAUTH_WORKER_URL` | Google OAuth worker `/authorize` | 선택(url) |
| `VITE_GITHUB_OAUTH_WORKER_URL` | GitHub OAuth worker `/authorize` | 선택(url) |
| `VITE_CRAWLER_MANAGER_WORKER_URL` | crawler CRUD + `/authentication/token` 교환 | 선택(url) |
| `VITE_SCHEDULER_MANAGER_WORKER_URL` | scheduler/stage/run API | 선택(url) |
| `VITE_CRAWLER_CODE_RUNNER_FUNCTION_URL` | 코드 테스트 실행 `/run` | 선택(url) |
- 부팅 시 zod `safeParse` — 실패 시 throw로 기동 중단. 단, "선택" URL이 없으면 해당 기능 사용 시점에 런타임 에러 메시지 ("Service is not available..." / "...is not configured").

### 8.2 REST 엔드포인트 (프론트가 소비하는 계약)
```
crawler-manager worker  (Bearer JWT)
  POST   /authentication/token          {provider, access_token} → {token, expires_in}   # 인증 헤더 없음
  GET    /crawlers?offset&limit         → {data[], total, offset, limit}
  POST   /crawlers                      {name, url_pattern, code} → CrawlerRow
  GET    /crawlers/{id}                 → CrawlerRow
  PUT    /crawlers/{id}                 타입별 payload (§4.3.7) → CrawlerRow
  DELETE /crawlers/{id}

scheduler-manager worker (Bearer JWT)
  GET/POST /schedulers, GET/PUT/DELETE /schedulers/{id}
  GET/POST /schedulers/{id}/stages, PUT/DELETE /schedulers/{id}/stages/{stageID}
  PUT    /schedulers/{id}/stages/reorder   {stage_ids: string[]}
  GET    /schedulers/{id}/runs?offset&limit

crawler-code-runner function (인증 없음)
  POST   /run   {type:'test', url, code} → {type, result} | {error, error_description}
```

### 8.3 TanStack Query 패턴
- QueryClient 전역 기본: `staleTime 5분`, `retry 1`.
- Query keys 계층: `['crawlers']` / `['crawlers', id]` / `['schedulers']` / `['schedulers', id]` / `['schedulers', id, 'stages']` / `['schedulers', id, 'runs']`.
- 목록: `useInfiniteQuery` + `{offset, limit:20}` pageParam, `getNextPageParam: offset+limit < total`, `pages.flatMap`으로 평탄화. UI는 자동 무한스크롤이 아니라 **명시적 "Load More" 버튼**.
- 뮤테이션: `mutateAsync` 노출(호출부 try/catch + toast), `onSuccess`에서 목록 key invalidate. update는 추가로 `setQueryData(detailKey, data)` 즉시 캐시 반영.
- 활성화 gating: 토큰 존재 시에만 `enabled` (`loadAuthenticationData()` 를 렌더 중 직접 호출 — 반응성 없음). `useGetCrawler`는 `skipToken` 사용.
- 훅 반환 규격 통일: `{데이터, isLoading, error(→undefined), refetch, hasNextPage?, fetchNextPage?, isFetchingNextPage?}` / 뮤테이션 `{동사, status, error, reset}`.

### 8.4 fetch 관례
- 인증: `Authorization: Bearer {JWT}` — 토큰 없으면 즉시 `Error('Authentication required. Please sign in.')` throw.
- 타임아웃: `AbortSignal.timeout(30_000)` (crawler/scheduler), 콜백 토큰 교환 10s, code-runner는 수동 AbortController 30s.
- 에러 규약: 응답 body `{error, error_description}` → `error_description ?? error ?? "Request failed with status {n}"` 메시지로 Error throw. JSON 파싱 실패도 status 메시지로 폴백.
- 에러 표면화: 목록/상세 = 인라인 error state + Retry 버튼. 뮤테이션 = error toast. 성공 뮤테이션 = success toast.
- 중복: `use-crawler-manager`는 요청별 함수에 fetch 보일러플레이트 반복, `use-scheduler-manager`는 `authenticatedFetch` 공용화 — 동일 헬퍼(getAccessToken/getBaseURL/parseResponseJSON/throwResponseError)가 **두 파일에 복붙** (§10).

---

## 9. 테스트 / Storybook 현황

### 9.1 Vitest — 18개 테스트 파일 (browser mode)
- 러너: Vitest 4 **browser mode** (`@vitest/browser-playwright`, chromium headless) + `vitest-browser-react` + testing-library matcher. env는 `vitest.config.ts` `define`으로 스텁 (runner `http://localhost:9999`, manager `http://localhost:8888`).
- MSW: `tests/extensions.ts` 가 worker 자동 기동 fixture 제공. 전역 `handlers = []` (비어 있음) — 각 테스트가 `worker.use()`로 핸들러 주입.
- 커버 시나리오 (파일: 개수):
  - `CrawlerEditorPage.test.tsx` (16): view 기본 read-only/test 패널 토글 영속/Edit 진입 시 패널 강제 on/dirty 전 Save disabled/save 성공 후 view 복귀/GET 실패 retry/data 크롤러(URL pattern 없음, input schema 편집)/name 비우면 Save disabled/Cancel 복원+discard confirm/clean cancel은 dialog 없이/Keep editing 유지/Unsaved 뱃지 토글/PUT 실패 시 edit 유지+toast/invalid JSON schema 인라인 에러/create 빈 폼+Submit/create POST 후 상세 라우트 이동.
  - `use-crawler-manager.test.tsx` (17): CRUD별 성공/에러/Authorization 헤더/쿼리 파라미터/PUT body에 id 제외/id 없으면 미호출.
  - `use-crawler-code-runner.test.tsx` (9): 상태 전이, 로그 발행 순서, 구조화 에러 파싱, status 폴백, reset.
  - `AuthenticationContext.test.tsx` (8): 복원/만료/파손 localStorage, loginWithProvider, logout, 미설정 URL 에러 콜백.
  - 컴포넌트: NavigationLinks(4)/ProtectedRoute(3)/SignInButtons(5)/UserAvatar(4)/JSONResultPanel(5)/LogOverlay(4)/StatusLogPanel(4)/URLInputPanel(4).
  - 기타: ToastContext(5)/LoggerContext(6)/use-authentication(4)/use-media-query(3)/crawler-code-runner 스키마(12)/environment 스키마(6).
- **미커버**: SchedulersPage/SchedulerDetailPage/StageList(DnD)/StageCreateDialog/RunHistorySection/use-scheduler-manager 전체, CrawlersPage 목록/삭제, AuthenticationCallbackPage 토큰 교환.

### 9.2 Playwright E2E — **설정만 존재, 테스트 0개**
- `playwright.config.ts`: testDir `sources/tests/e2e` (`.gitkeep`만 존재), chromium/firefox/webkit, baseURL `http://localhost:5173`, `pnpm dev` webServer.

### 9.3 Storybook — **설정만 존재, 스토리 0개**
- `.storybook/main.ts` glob `sources/**/*.stories.*` — 매칭 파일 없음. addons(essentials/interactions/chromatic/onboarding) 설치만 됨.

→ 재작성 시 "Vitest 시나리오 목록(§9.1)"이 사실상의 행위 회귀 스펙. E2E/Storybook은 껍데기이므로 이전 부담 없음.

---

## 10. 보존할 UX vs 개선할 UX

### 보존 (재디자인에도 유지해야 할 행위)
1. **new/detail 단일 에디터** + `key` 리셋, create/view/edit 3모드와 모드별 액션 버튼 체계.
2. **Dirty 안전망 3종 세트**: Unsaved 뱃지 / DiscardDialog(Cancel·Back) / beforeunload — 그리고 "clean이면 dialog 생략" 규칙.
3. **저장 중 입력 보호** (`markSaved`의 form 동일성 비교 — 저장 응답이 사용자의 후속 타이핑을 덮지 않음).
4. 키보드 단축키 ⌘S/⌘E/⌘↵ + 버튼 힌트 + Mac/Win 라벨 분기, form 요소 포커스 시 ⌘E 무시.
5. **draft 코드로 테스트 실행** ("· running draft" 표시 포함) — 저장 없이 반복 실험하는 핵심 루프.
6. view mode test 패널 토글의 localStorage 영속 / edit·create에서 강제 표시.
7. 타입별 폼 규칙: web=url_pattern 필수+input schema 고정, data=input schema 편집. disabledReason 메시지 우선순위.
8. 스테이지 DnD의 **optimistic + rollback**, 5px activation(클릭 보호), 키보드 재정렬, order 재부여 규칙.
9. Stage 생성의 Simple/JSON 이중 모드와 crawler 선택 시 schema prefill.
10. 스케줄러 인라인 편집 계약: blur/Enter commit, Escape 취소, 변경 시에만 PUT, 빈 cron → null("Manual only").
11. 목록 공통 패턴: loading/error+Retry/empty CTA/Load More, 카드 전체 클릭 + 키보드 activation, 삭제 confirm(스케줄러는 cascade 경고 문구).
12. 실행 로그의 자동 발행 시퀀스와 수동 Clear, 결과 JSON Copy, run history 행 확장.
13. 접근성 자산: aria-disabled+사유 노출, aria-live 상태, role=switch/alertdialog, VisuallyHidden — 재구현 시 하향 금지.
14. TanStack Query 계약: key 계층, invalidate/setQueryData 규칙, 훅 반환 규격, 에러 메시지 도출 규약(§8.4).

### 개선 (재작성에서 고칠 것)
1. **CrawlerEditorPage 831줄 해체**: styled 선언 ~40개가 페이지에 인라인 + TopBar/폼/테스트 컬럼이 한 컴포넌트. 로직은 이미 `use-crawler-editor`로 분리되어 있으므로 뷰 분해(TopBar/DetailsSection/SchemaSection/TestPanel)와 스타일 계층 분리가 핵심.
2. **죽은 의존성/코드 제거**: recoil·zustand·jotai(§6), radix dropdown-menu/navigation-menu/popover/slot, `use-media-query`(미사용), LoggerContext(미마운트 — 채택하거나 삭제), `VITE_GOOGLE_CLIENT_ID`(TODO 잔재), AuthenticationContext의 항상-false `isLoading`.
3. **중복 통합**: CrawlersPage↔SchedulersPage가 목록/삭제 confirm/스피너/Load More까지 거의 전문 복붙(각 460+줄). 제네릭 리스트 페이지 or 공용 컴포넌트화. fetch 헬퍼 2벌(§8.4)도 단일 API 클라이언트로.
4. **confirm UI 이원화 해소**: 목록 삭제는 자체 모달(포커스 트랩 없음), 에디터는 Radix DiscardDialog — 단일 confirm 컴포넌트로 통일. StageCard 삭제에 확인 부재도 함께.
5. **SPA 내 라우팅 dirty guard 부재**: GNB 클릭 시 편집 내용 경고 없이 이탈. react-router blocker 도입.
6. **삭제 optimistic/로딩 표현 부족**: deleteStatus pending 동안 버튼만 disabled — 행 단위 피드백 없음.
7. **토큰 반응성**: `loadAuthenticationData()`를 렌더 중 직접 읽어 `enabled` 결정 — 만료 시 UI 반영이 리렌더 의존. 인증 상태를 단일 소스(context/atom)로.
8. **모바일/반응형 미설계**, 다크 고정 — 재디자인 시 테마 토큰은 이미 CSS 변수라 확장 용이.
9. **스케줄러 UX 공백**: 수동 run 트리거 버튼 없음, cron 문법 검증/미리보기 없음, stage 수정(update) API 훅은 있으나 UI 없음(`useUpdateStage` 미사용).
10. **로그 상태의 페이지 종속**: executionLogs가 페이지 state — 에디터 구조 변경 시 실행 세션 단위 스토어로.
11. 스타일 방식 3종 혼재(§7) 단일화, E2E/Storybook 껍데기는 재작성 시 실사용 여부부터 결정.
