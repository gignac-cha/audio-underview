# 04 웹 — 로그인 화면과 홈 화면 다시 만들기

## 1. 만들 것

`applications/web`의 화면 두 개를 새로 만든다. 기능은 이 문서대로, **디자인은 처음부터 새로** 만든다(§6).

| 화면 | 경로 | 내용 |
| -- | -- | -- |
| 로그인 | `/sign/in` | 소셜 로그인 목록(§3) |
| 홈 | `/home` | 로그인한 사용자의 첫 화면(§5) |

두 화면을 잇는 로그인 복귀 처리(`/authentication/callback`, §4)도 같이 바꾼다. 이것이 없으면 로그인해서 홈에 갈 수 없다.

**다른 화면**(`/crawlers`, `/schedulers` 등)은 이 작업의 대상이 아니다.
- 그 화면들의 코드, 그 화면들이 쓰는 기존 공용 컴포넌트(`PageHeader`, `NavigationLinks`, `UserAvatar` 등), `styles/global.scss`의 기존 CSS 변수는 **지우거나 고치지 않는다**. 새 화면은 새로 만든 것만 쓴다.
- 이 작업 뒤 그 화면들의 API 호출은 401로 실패한다. 로그인 토큰이 바뀌기 때문이다(§4). 허용된 결과이므로 고치지 않는다.
- `typecheck`, `lint`, `build`, 다른 화면의 기존 테스트는 계속 통과해야 한다.

## 2. 기술 조건

- React 19, `react-router`, `@emotion/styled`, `@tanstack/react-query`, `zod` 등 이미 있는 것을 쓴다. Radix와 FontAwesome도 이미 의존성에 있다.
- UI 프레임워크(Tailwind, MUI 등)는 추가하지 않는다. 서체 패키지처럼 디자인에 꼭 필요한 것만 `pnpm add`로 추가할 수 있다.
- `index.html`의 `lang`을 `ko`로 바꾼다.

## 3. 로그인 화면 `/sign/in`

**동작**
- 이미 로그인한 사용자는 `/home`으로 보낸다(`replace`).
- 제공자 15개를 아래 순서로 보여준다. 상태는 두 가지다.

| 순서 | id | 상태 |
| -- | -- | -- |
| 1 | `google` | `available` |
| 2 | `github` | `available` |
| 3~15 | `apple`, `microsoft`, `facebook`, `x`, `linkedin`, `discord`, `kakao`, `naver`, `threads`, `tiktok`, `line`, `bluesky`, `twitch` | `preparing` |

- 상태 표는 `Record<OAuthProviderID, 'available' | 'preparing'>` 타입의 상수 하나로 둔다. 제공자 id가 늘면 typecheck가 실패해야 한다. `Application.tsx`의 `ENABLED_PROVIDERS`는 없애고, 이 상수에서 만든 목록을 `AuthenticationProvider`에 넘긴다.
- 표시 이름은 `PROVIDER_DISPLAY_CONFIGURATIONS[id].displayName`을 쓴다.
- `available`: 누르면 로그인을 시작하는 버튼이다. `google`은 `loginWithGoogle()`, `github`은 `loginWithGitHub()`.
- `preparing`: 버튼이 아니다. 누를 수 없고 포커스도 받지 않는다. "준비 중"임을 글자로 알린다.
- `available` 제공자의 워커 URL이 설정돼 있지 않으면(`isGoogleConfigured`, `isGitHubConfigured`가 `false`) 누를 때 오류 알림을 보여주고 이동하지 않는다.

**문구**
- 서비스 이름: `Audio Underview`
- 소개 한 줄: `웹에서 모은 소식을 오디오 뉴스캐스트로 듣습니다`
- 버튼: `Google로 계속하기`, `GitHub로 계속하기`(`<displayName>로 계속하기`)
- 준비 중 묶음 제목: `준비 중인 로그인`
- 오류 알림: 제목 `로그인을 시작하지 못했습니다`, 내용 `잠시 후 다시 시도해주세요.`

## 4. 로그인 복귀 처리 `/authentication/callback`

OAuth 워커는 로그인 뒤 이 주소로 돌려보내며 쿼리에 `user`, `access_token`, `uuid`, `session_token`을 붙인다. 실패하면 `error`, `error_description`을 붙인다.

처리 순서:
1. `error`가 있으면 실패 처리한다. 내용은 `error_description`, 없으면 `로그인에 실패했습니다.`
2. `user`가 없거나, `JSON.parse(decodeURIComponent(user))`가 `oauthUserSchema`(`@audio-underview/sign-provider`)를 통과하지 못하면 실패 처리한다. 화면 안에 제공자 목록을 따로 적지 않는다.
3. `session_token`이 없으면 실패 처리한다. `access_token`으로 대신하지 않는다.
4. `getJWTExpiration(session_token)`으로 만료 시각(ms)을 구한다. 값이 없거나 지금보다 이르면 실패 처리한다.
5. `loginWithProvider(user.provider, user, session_token, 만료 시각 - Date.now())`를 부른다. 성공하면 `/home`으로 간다(`replace`). 실패하면 실패 처리한다.

- 실패 처리: 오류 알림(제목 `로그인 실패`)을 보여주고 `/sign/in`으로 간다(`replace`). 알림 내용은 경우마다 다르다.
  - `error`가 있음: `error_description`, 없으면 `로그인에 실패했습니다.`
  - `user`가 없거나 잘못됨: `로그인 정보를 확인하지 못했습니다.`
  - `session_token`이 없음: `세션 토큰을 받지 못했습니다.`
  - 만료 시각이 없거나 지남: `세션 토큰이 만료되었습니다.`
  - `loginWithProvider` 실패: `로그인 정보를 저장하지 못했습니다.`
- crawler-manager의 `/authentication/token`은 부르지 않는다. 그 호출 코드를 지운다.
- 처리 중에는 `로그인하는 중입니다` 상태 화면을 보여준다. 새 디자인으로 만든다.
- 같은 복귀를 두 번 처리하지 않는다(React StrictMode의 effect 재실행 포함).
- 토큰과 `user` 값은 로그에 남기지 않는다.

## 5. 홈 화면 `/home`

`ProtectedRoute` 안에 있다. 로그인하지 않았으면 `/sign/in`으로 간다.

**구성**
1. **상단 바**: 서비스 이름(누르면 `/home`), 메뉴 `홈`(`/home`)·`크롤러`(`/crawlers`)·`스케줄러`(`/schedulers`), 사용자 영역(프로필 사진 또는 이름 첫 글자, 이름, `로그아웃`).
2. **계정**: 이름, 이메일(없으면 그 줄을 생략), 프로필 사진(없으면 이름 첫 글자), 로그인에 쓴 제공자(`<displayName>로 로그인함`).
3. **연결된 로그인**: 아래 API로 가져온 목록. 항목마다 제공자 이름과 연결한 날짜.
4. **바로가기**: 카드 두 개. 데이터를 불러오지 않는 링크다.
   - `크롤러` — `웹 페이지에서 필요한 내용을 뽑는 코드를 만들고 시험합니다` → `/crawlers`
   - `스케줄러` — `크롤러를 순서대로 묶어 실행합니다` → `/schedulers`

**연결된 로그인 API**
- 요청: `GET <워커 URL>/accounts`, 헤더 `Authorization: Bearer <credential>`.
  - `credential`은 `loadAuthenticationData()`(`@audio-underview/sign-provider`)의 값이다.
  - 워커 URL은 로그인한 제공자의 것이다. `google`이면 `VITE_GOOGLE_OAUTH_WORKER_URL`, `github`이면 `VITE_GITHUB_OAUTH_WORKER_URL`.
- 응답 200: `{ "accounts": [{ "provider": "<id>", "linkedAt": "<ISO 8601>" | null }] }`. zod로 검증한다.
- `@tanstack/react-query`로 부른다.

| 상태 | 화면 |
| -- | -- |
| 불러오는 중 | 자리 표시(skeleton) |
| 성공 | 목록. 날짜는 `Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' })`. `linkedAt`이 `null`이면 날짜를 생략 |
| 목록이 빔 | `연결된 로그인이 없습니다` |
| 401 | 로그아웃하고 `/sign/in`으로 간다. 알림: 제목 `세션이 만료되었습니다`, 내용 `다시 로그인해주세요.` |
| 그 밖의 실패, 워커 URL 없음 | `연결된 로그인을 불러오지 못했습니다`와 `다시 시도` 버튼 |

**로그아웃**: `logout()`을 부르고 `/sign/in`으로 간다.

**문구**
- 인사: `<이름>님, 안녕하세요`
- 구역 제목: `계정`, `연결된 로그인`, `바로가기`

## 6. 디자인

**지금 디자인을 고쳐 쓰지 않는다. 처음부터 새로 만든다.**

버릴 것(지금 디자인의 특징):
- 어두운 배경 위 보라색 그라디언트, 가운데 놓인 카드 하나
- 제공자마다 다른 브랜드 색으로 칠한 버튼을 세로로 쌓은 목록
- 영어와 한국어가 섞인 문구
- `global.scss`의 색·그림자·테두리 변수, `Outfit` 서체

서비스 설명(디자인의 출발점):
- Audio Underview는 웹에서 정보를 모으는 크롤러를 만들고, 스케줄로 묶어 실행하고, 그 결과를 오디오 뉴스캐스트로 듣는 서비스다.
- 쓰는 사람은 직접 크롤러 코드를 짜는 개인이다. 화면은 한국어다.
- 도구다운 차분함과 읽기 쉬움이 먼저다. 장식보다 글과 구조로 말한다.

요구:
- **방향을 먼저 정한다.** 색, 서체, 여백, 모서리, 움직임에 대한 결정을 5~10줄로 적고, 왜 이 서비스에 맞는지 적는다. 이 글은 PR 본문에 넣는다.
- **디자인 토큰을 한 곳에 둔다.** 색, 글자 크기 단계, 여백 단계, 모서리, 그림자, 움직임 시간을 한 모듈에 정의하고 두 화면이 그것만 쓴다. 화면 안에 색 값이나 px 값을 직접 쓰지 않는다.
- **서체**는 한글 글리프가 있는 것을 쓴다. 외부 CDN 링크 대신 패키지나 시스템 서체를 쓴다.
- **밝은 테마와 어두운 테마 중 기본을 하나 정하고** 이유를 방향 글에 적는다. 토큰은 나머지 테마를 나중에 추가할 수 있는 구조로 둔다.
- **제공자 표시**: 버튼 모양은 하나로 통일하고 로고로 구분한다. 로고는 각 제공자의 공식 마크를 쓴다. `available` 제공자가 화면의 주된 행동이고, `preparing` 제공자는 그보다 눈에 덜 띄어야 한다.
  - Google 마크는 [Google 브랜드 규정](https://developers.google.com/identity/branding-guidelines)대로 표준 색 G(단색 금지)를 흰 바탕 위에 둔다. 색이 있는 버튼 안에서는 로고를 흰 칩 위에 놓는다. 홈 화면에 나오는 Google 마크도 표준 색으로 쓴다.
- **반응형**: 너비 360, 768, 1280에서 각각 맞는 배치. 가로 스크롤이 생기지 않는다.
- **접근성**
  - 글자 명암비 4.5:1 이상
  - 키보드로 모든 동작 가능, 포커스 표시가 보인다
  - 누르는 대상은 44px 이상
  - `prefers-reduced-motion`을 따른다
  - 제목 단계와 landmark(`header`, `nav`, `main`)를 쓴다
- **상태를 모두 디자인한다**: 로그인 화면(기본, 버튼 hover·focus·누름), 복귀 처리 중, 홈(불러오는 중, 성공, 빈 목록, 실패).

검토:
1. 구현한 뒤 아래 스크린샷을 찍는다. 너비 360·768·1280 각각.
   - 로그인 화면
   - 복귀 처리 중
   - 홈(성공)
   - 홈(불러오는 중)
   - 홈(실패)
2. 스크린샷을 보고 문제를 5개 이상 구체적으로 적는다(정렬, 간격, 위계, 명암, 줄바꿈, 넘침 등).
3. 고친 뒤 다시 찍는다. 이 과정을 한 번 이상 한다.
4. 마지막 스크린샷을 사용자에게 보여준다.

## 7. 테스트

기존 방식(vitest 브라우저 모드)으로 쓴다. 모양이 아니라 동작을 확인한다. 바뀐 화면의 옛 테스트는 새 동작에 맞게 다시 쓴다.

**로그인 화면**
- 제공자 15개가 §3 순서로 나온다. 상태 상수가 모든 `OAuthProviderID`를 한 번씩 담는다.
- `Google로 계속하기`를 누르면 `loginWithGoogle`이, `GitHub로 계속하기`를 누르면 `loginWithGitHub`이 불린다.
- `preparing` 제공자는 버튼 role이 아니고, `준비 중` 글자가 있다.
- 로그인한 상태로 열면 `/home`으로 간다.

**복귀 처리**
- 올바른 `user`와 `session_token`이면 `loginWithProvider`가 그 토큰과 `exp` 기준 남은 시간으로 불리고 `/home`으로 간다.
- `session_token`이 없으면 실패 처리되고, `access_token`이 있어도 로그인하지 않는다.
- `error`가 있으면 `error_description`으로 알린다.
- `user`가 잘못됐거나, 토큰이 이미 만료됐으면 실패 처리된다.
- 실패 경우마다 알림 내용이 §4의 문구와 같다.
- `fetch`를 한 번도 부르지 않는다.

**홈 화면**
- 이름, 이메일, 로그인 제공자가 보인다. 이메일이 없으면 그 줄이 없다.
- 로그인 제공자의 워커 URL로 `/accounts`를 부르고 `Authorization` 헤더에 credential을 보낸다.
- 성공, 불러오는 중, 빈 목록, 실패와 `다시 시도`가 §5 표대로 동작한다.
- 401이면 `logout`이 불리고 `/sign/in`으로 간다.
- `로그아웃`을 누르면 `logout`이 불리고 `/sign/in`으로 간다.
- 메뉴와 바로가기 링크의 주소가 맞다.
