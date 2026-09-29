# 프로토타입 → 프로덕션 이관 계획 (메인 세션 정본)

작성 2026-09-14. 원본은 Linear 팀 문서 "프로토타입 → 프로덕션 이관 계획"(2026-08-21)이고, 이 파일은 그 **정정판이자 메인 저장소의 정본**이다. 단위별 설계 문서(`01-*.md` 이후)는 이 문서의 §8 규약을 전제로 차이점만 적는다.

## 1. 배경

프로덕션(이 저장소 `main`)은 크롤러 등록·크롤러 마켓플레이스·크롤러 간 노드 그래프·스케줄러(+마켓플레이스)를 목표 아키텍처로 잡고 시작했으나, 규모 때문에 데모가 나오지 않았다. 프로토타입(브랜치 `worktree-prototype-scaffold`, 2026-07-08 시작)은 그 우회로로 **완전히 배타적으로 작성한 PoC**이며, 거기서 검증된 기능을 프로덕션에 **한 단위씩 이관**하는 것이 목적이다. 직접 머지는 목적이 아니다.

수치(2026-08-21 실측): 프로토타입 80,162 LOC vs 프로덕션 18,089 LOC. 프로토타입 30커밋은 프로덕션 소스를 한 줄도 건드리지 않았다(머지 충돌 0). `-prototype` 접미사 포크 8쌍은 모두 메인 판을 그대로 포함하고 기능만 더한 것이다.

## 2. 원칙

1. **이관 단위 = 자체 검증 가능한 기능.** 절반 이식·stub·임시 우회 금지. 단위 내부의 타협은 "완벽하게 동작"의 위반이다.
2. **단위는 통째로 옮긴다.** 프로토타입 판은 실전 검증된 상태이므로 옮기며 손보는 것 자체가 검증을 무효화한다. 바꾸는 건 seam(이름·binding·환경변수·import 경로·모듈 위치)뿐이다. 대응물이 있으면 옛 것을 들어내고 교체한다(병행 유지 없음).
3. **기능 간 연결은 끊겨도 되지만 숨기지 않는다.** 각 단계 완료 보고에 "이 단계로 끊긴/아직 붙지 않은 연결 → 재접속 단계"를 추적 목록(§8.5 형식)으로 명시한다.
4. **프로덕션 서비스는 이행 중 망가져도 된다.** 단, 옮긴 단위는 완벽하게 동작해야 한다.
5. **플랫폼과 그 위의 기능을 구분한다.** 크롤러·스케줄러·마켓플레이스·로그인과 계정·logger·provider 키 볼트가 플랫폼이고, 뉴스캐스트는 그 위에서 크롤러를 이름으로 호출해 만드는 **기능 하나**다. 플랫폼 패키지는 뉴스캐스트 패키지(`newscast-*`)를 import하지 않는다. 프로토타입에서는 의존 없는 패키지가 `newscast-core-prototype` 하나뿐이라 logger·볼트가 거기 기대게 됐는데, 이관 시 그 결합을 풀어서 들여온다(§4 (d)).

## 3. 이관 순서 (정정판)

| 순서 | 단위 | 문서 | 완료 기준 | 이 단계로 생기는 미접속·끊김 |
| -- | -- | -- | -- | -- |
| 0 | **로그인 워커 교체** — `packages/supabase-connector`에 세션 JWT·계정 연결·redirect_uri 정책 모듈 추가, google/github OAuth 워커를 프로토타입 판으로 교체 | `01-login-workers.md` | 프로덕션 도메인에서 로그인 → 세션 JWT 발급 → 워커의 보호 라우트(`GET /accounts`) 통과, connector·워커 테스트 그린 | 세션 JWT를 쓰는 웹 화면 없음(3) · 계정 연결 UI 없음(3) · JWT 발급자 2곳 공존(3) |
| 1 | **볼트 이관** — `packages/logger` 교체(로그 scrubber + provider 키 마스킹 블록), `workers/provider-key-vault-worker` 신규, D1·시크릿 프로비저닝 | `02-vault.md` (예정) | 테스트 그린 + `wrangler dev` 로컬 왕복 + 검증 시간에만 공개해 6 라우트 왕복(키 등록→상태→프록시→감사→삭제) 후 비공개 복귀 | 볼트 호출자 없음(2) · 키 등록 UI 없음(3) |
| 2 | **파이프라인 슬라이스** — `packages/newscast-core` 및 뉴스캐스트 패키지 4종, 파이프라인 워커(잡 D1·Workflows·R2), `executeCrawlerByName` RPC, 크롤러 5종 시딩(데이터) | `03-pipeline.md` (예정) | 프로덕션에서 잡 생성 → 크롤(등록 크롤러 경유) → 대본 → TTS → MP3 재생 전 경로 | 뉴스캐스트 페이지 없음(3) |
| 3 | **웹 이식** — 뉴스캐스트 페이지·공유 UI·키 등록 UI·세션 JWT 소비 | `04-web.md` (예정) | 전체 UX 동작 + 추적 목록의 항목 전부 재접속 | — |

각 단위는 직전 단위 위에만 얹힌다. 0과 1은 코드 의존이 없어 병렬 가능하지만, 0이 작아 절차 검증용으로 먼저 돈다.

## 4. Linear 원본 대비 정정 사항 (2026-09-14 실측)

- (a) **0단계에서 "raw-token을 쓰던 프로덕션 웹 화면이 끊긴다"는 틀렸다.** 프로토타입 callback도 `user`·`access_token`·`uuid`를 그대로 보내고 `session_token`을 **추가**할 뿐이다. 메인 웹은 추가 파라미터를 무시하고 지금처럼 crawler-manager `/authentication/token`으로 교환하므로 로그인 흐름은 유지된다.
- (b) **볼트는 로그인 워커에 의존하지 않는다.** 볼트는 JWT를 검증하지 않고 호출자가 `userId`를 넘긴다. 세션 JWT를 검증해 `sub`를 넘기는 쪽은 2단계 파이프라인 워커다.
- (c) 0단계에서 옮기는 차이는 "3파일 192줄"이 아니라 connector 신규 모듈 4개 1,116줄 + `index.ts` export 73줄 + `test-helpers.ts` 106줄 + 워커 `index.ts` 각 약 360줄 diff + 워커 테스트 각 약 900줄 diff.
- (d) **`newscast-core`는 1단계가 아니라 2단계에 들어온다.** 볼트·logger가 core에서 쓰는 것은 provider 키 마스킹 블록(`SECRET_PATTERNS`·`PROVIDER_TEXT_MAXIMUM_LENGTH`·`redactSecrets`·`truncateText`·`redactAndTruncate`, 약 100줄 + 테스트 describe 3개)뿐이며, 이 블록은 `packages/logger`로 옮긴다(함수 본문 무변경, 모듈 위치만). 볼트의 provider union은 이미 core를 import하지 않고 자체 선언돼 있다.
- (e) 0단계에 `worker-tools-prototype`은 불필요하다. `jwt.ts`는 메인 `worker-tools`와 동일하고 `signJWT`·`verifyJWT`를 이미 export한다.
- (f) Supabase 스키마 사전 확인은 코드 차원에서 해소됐다. `migrations/001~008`이 메인과 프로토타입에서 파일 단위로 동일하다. 남는 확인은 프로덕션 DB에 실제 적용됐는가뿐.

## 5. 사전 확인

- **OAuth 앱 credential·redirect URI**는 외부 상태(구글/GitHub 콘솔). 프로덕션 워커에 프로토타입 코드를 올릴 때 시크릿·KV id·`ALLOWED_ORIGINS`·`FRONTEND_URL`은 프로덕션 값을 유지한다.
- **Supabase**: 프로덕션 DB에 `packages/supabase-connector/migrations/001~008` 적용 여부. 프로토타입 connector의 `client.ts`는 Postgres 스키마 `prototype`으로 격리돼 있는데, **메인은 `public`을 그대로 쓴다** — 그 3줄은 가져오지 않는다.

## 6. 스토리지 결정

프로토타입이 검증한 답(잡·볼트·공유는 D1, 계정은 Supabase)을 프로덕션의 답으로 채택한다. 프로덕션 scheduler는 Supabase 전용(9파일)이고 프로토타입은 Supabase 3·D1 3으로 부분 전환된 상태 — 2단계에서 정본을 정한다.

## 7. 코드와 함께 옮기는 검증된 결정

- 볼트 프록시 타임아웃은 추론 모델 기준 240초. 호출자의 타임아웃은 그보다 길어야 한다(둘 다 과금되는 경쟁 상태 방지). 파이프라인 클라이언트의 timeout signal은 볼트 경로로 전달되지 않는다.
- wrangler.toml이 있는 Pages 프로젝트는 배포마다 toml이 env var 정본 — API/대시보드 var는 지워진다.
- `og:url`은 라우팅 필드 — 원본 기사로 바꾸지 말 것.
- verbatim(그대로 읽기)은 프롬프트가 아니라 구조로 보장한다(LLM 0회).
- 세션은 24시간 고정이면 로그아웃이 재발한다 — 수명 연장 또는 갱신이 필요하다(별건, 3단계 이후).
- 공개 DTO는 owner projection에서 필드를 빼는 방식이 아니라 allowlist로 새로 조립한다.
- Gemini 다중화자 TTS는 화자 정확히 2명(`SpeakerId = 1 | 2`).

## 8. 메인 세션 실행 규약

### 8.1 출처 표기와 복사

- 출처는 항상 **브랜치 `worktree-prototype-scaffold`, 커밋 `8bdfc7d`** 기준 경로로 적는다. 워크트리 체크아웃(`.claude/worktrees/prototype-scaffold`)이 지워져도 커밋은 저장소 객체에 남으므로, 복사는 워크트리 경로가 아니라 `git show 8bdfc7d:<경로>`로 한다.
  ```bash
  git show 8bdfc7d:packages/supabase-connector-prototype/sources/account-linking.ts > packages/supabase-connector/sources/account-linking.ts
  ```
- 파일은 통째로 복사한다. 부분 발췌는 단위 문서가 명시한 경우(예: 마스킹 블록)만.

### 8.2 이름 규칙

- 메인에는 `-prototype`이라는 글자가 **어디에도 생기지 않는다.** 패키지명·워크스페이스명·워커명·import 경로·주석 전부. 복사 뒤 대상 디렉터리에서 `grep -rn -i prototype`이 0건이어야 하며, 나온 줄은 하나씩 메인 이름으로 바꾼다.
- `@audio-underview/<name>-prototype` → `@audio-underview/<name>`. 메인에 대응물이 있으면(`logger`·`supabase-connector`·`worker-tools`·OAuth 워커 등) 그 안으로 들어가고, 없으면(`provider-key-vault-worker`·`newscast-core` 등) 접미사 없는 이름으로 새로 만든다.
- 저장소 CLAUDE.md의 명명 규칙(줄임말 금지·복수형·`.ts` 확장자 import·`??`)은 그대로 적용된다. 프로토타입 코드가 이미 그 규칙으로 작성돼 있으므로 새로 손댈 일은 거의 없다.

### 8.3 의존성

- `package.json`은 직접 편집하지 않는다. 단위 문서가 "추가 의존 없음"이라 적었으면 아무것도 하지 않고, 필요한 경우 `pnpm add <pkg>@workspace:*` / `pnpm add <pkg>@<version>`만 쓴다.
- 복사 후 루트에서 `pnpm install`로 lockfile을 맞춘다.

### 8.4 검증 명령과 완전 동작 판정

- 단위 문서가 나열한 패키지마다 `pnpm --filter <package-name> typecheck` 와 `pnpm --filter <package-name> test`.
- 루트 `pnpm typecheck`(turbo)로 **단위 밖에서 그 패키지를 쓰는 곳**이 깨졌는지 본다. 깨졌으면 고치지 말고 추적 목록에 올린다(원칙 3·4). 단, 단위 문서가 "이 변경은 순수 추가"라고 적은 경우에 깨졌다면 그것은 이관 오류이므로 고친다.
- "완벽하게 동작"의 판정은 단위 문서 §5(완전 동작 판정 절차)가 정한 실환경 절차를 **끝까지** 통과하는 것이다. 테스트 그린만으로는 완료가 아니다.

### 8.5 추적 목록 형식

각 단위의 완료 보고와 다음 단위 문서 첫머리에 아래 표를 둔다.

| 항목 | 상태 | 원인 | 재접속 단계 |
| -- | -- | -- | -- |
| (예) 세션 JWT를 쓰는 웹 화면 | 미접속 | 메인 웹이 `session_token`을 읽지 않음 | 3 |

상태는 `끊김`(있던 것이 동작 안 함) / `미접속`(새 기능인데 아직 쓰는 곳이 없음) 둘 중 하나.

### 8.6 위임 표준 구성 — dynamic workflow agent team (opus 5 and sonnet 5 only)

- **모델**: 워크플로 에이전트는 opus 5와 sonnet 5만 쓴다. 모든 `agent()`에 `model: 'opus'` 또는 `'sonnet'`을 명시한다 — 생략(세션 모델 상속) 금지, fable 금지. 판단이 들어가는 레인(구현·검증·수정)은 `'opus'`, 적대 검증과 재검증은 `effort: 'high'`, 순수 기계적 레인만 `'sonnet'`. 오케스트레이터(세션 모델)는 코드를 쓰지 않고 설계·지시·통합·최종 검증·커밋·보고만 한다.
- 레인은 **파일 소유권으로 나눈다**(같은 파일을 두 레인이 만지지 않음). 레인 간 계약(export 목록·요청 스키마)은 단위 문서에 전문으로 적어 프롬프트에 그대로 넣는다.
- 마지막에 통합 + **적대 검증(REFUTE) 레인**을 둔다. 단위 문서 §8의 REFUTE 대상을 반드시 포함하고, 검증 레인은 코드를 수정하지 않는다.
- 수정 라운드는 HIGH만. MEDIUM·LOW는 보고에 남기고 사용자가 정한다.
- 범위가 작은 수정(파일 1~2개)은 위임 고정비(cold start·직렬 대기) 때문에 인라인이 더 빠르다.

### 8.7 배포·시크릿

- 배포는 단위 문서의 "사람이 준비할 것"이 갖춰진 뒤 **사용자 승인 후**에만. 배포 계정·wrangler 프로필은 메인 세션의 기존 절차를 따른다(이 문서는 정하지 않는다).
- 시크릿 값·계정 id는 문서·프롬프트·커밋·로그 어디에도 적지 않는다. placeholder 이름만 적는다. toml에 리소스 id를 커밋할 때는 placeholder로 커밋한 뒤 로컬에서 실제 값으로 되돌린다.

### 8.8 커밋

- 저장소 CLAUDE.md 규약: `feature(<workspace-package-name>): ...`, 여러 패키지에 걸치면 scope 생략. git 쓰기 작업은 사용자 지시가 있을 때만.
- 커밋 전 staged diff에서 계정 id·시크릿 패턴 grep 0건 확인.

## 9. 문서 목록

- `00-migration-plan.md` — 이 문서.
- `01-login-workers.md` — 0단계. 작성 완료. Linear TES-100(하위 101~104), 마일스톤 "프로토타입 이관".
- `02-vault.md` — 1단계. 0단계 완료 후 작성.
- `03-pipeline.md` — 2단계.
- `04-web.md` — 3단계.
