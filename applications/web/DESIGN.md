# Audio Underview 웹 디자인

`applications/web`의 새 디자인 시스템(`sources/design-system`)을 설명한다. 값의 정본은 코드(`sources/design-system/tokens.ts`)이고, 이 문서는 그 값이 **왜** 그런지와 **어떻게** 쓰는지를 적는다. 코드와 이 문서가 다르면 코드가 맞다 — 이 문서를 고친다.

- 적용 화면: 로그인(`/sign/in`), 로그인 복귀 처리(`/authentication/callback`), 홈(`/home`).
- 다른 화면(`/crawlers`, `/schedulers` 등)은 아직 옛 스타일(`sources/styles/global.scss`)을 쓴다. 공존 규칙은 [옛 스타일과의 공존](#옛-스타일과의-공존)을 본다.
- 명세: `documents/migration/04-web-sign-in-and-home.md` §6.

## 1. 원칙

Audio Underview는 웹에서 정보를 모으는 크롤러를 만들고, 스케줄로 묶어 실행하고, 그 결과를 오디오 뉴스캐스트로 듣는 서비스다. 쓰는 사람은 크롤러 코드를 직접 짜는 개인이고, 화면은 한국어다.

1. **도구답게 차분하게.** 코드 편집기 옆에 켜 두어도 피곤하지 않아야 한다. 장식 대신 글의 위계와 정렬이 정보를 전한다.
2. **읽기 쉬움이 먼저.** 작은 한글 받침까지 또렷해야 한다. 밝은 바탕, 짙은 글자, 넉넉한 행간.
3. **과감한 곳은 한 곳.** 로그인 화면의 큰 서비스 이름 하나. 나머지는 조용하고 절제한다.
4. **색은 뜻이 있을 때만.** 누를 수 있는 것(청록)과 문제가 생긴 것(벽돌색) 두 가지 뜻에만 색을 쓴다.
5. **구조가 뜻을 나타낸다.** 테두리·면·구분선은 정보를 담을 때만 쓴다. 같은 카드를 반복하지 않는다. 목록은 행으로, 누를 수 있는 것은 카드·버튼으로 구분한다.
6. **모든 상태를 디자인한다.** 기본만이 아니라 hover·focus·누름, 불러오는 중·빈 목록·실패까지.

### 쓰지 않는 것

옛 디자인과 흔한 생성형 디자인의 기본값을 피한다.

- 어두운 배경 위 보라색 그라디언트, 가운데 놓인 카드 하나
- 제공자마다 다른 브랜드 색으로 칠한 버튼을 세로로 쌓은 목록
- 영어와 한국어가 섞인 문구
- `global.scss`의 색·그림자·테두리 변수, `Outfit` 서체
- 그라디언트 장식, 모든 카드에 같은 회색 그림자
- 대문자 eyebrow 라벨, 모노스페이스 작은 라벨, `A · B · C` 식 메타 문자열, 링크 끝의 `→`
- 제목의 한 단어만 색·기울임으로 강조하기
- 섹션마다 나타나는 페이드·슬라이드, 모든 카드의 hover 전환

## 2. 테마

기본은 **밝은 테마**다. 크롤러 코드와 수집 결과를 오래 읽는 도구라서 밝은 바탕에 짙은 글자가 가장 또렷하다.

- 색·그림자·움직임 시간은 CSS custom property로 풀린다. 이름은 `--underview-<묶음>-<역할>`이다(예: `--underview-color-ink`, `--underview-duration-quick`).
- `PageLayout`이 루트 요소에 `data-underview-theme="light"`와 변수 값을 선언한다. 컴포넌트는 `color.ink`처럼 토큰을 쓰고, 그 값은 `var(--underview-color-ink)`다.
- 테마는 `tokens.ts`의 `Theme` 객체 하나다: `colorScheme`, `color`(역할 23개), `shadow`(역할 1개).

### 어두운 테마를 더할 때

1. `tokens.ts`에 `darkTheme: Theme`을 만들고 `themes`에 `dark: darkTheme`을 더한다. 역할 이름은 밝은 테마와 같아야 한다(타입이 강제한다).
2. 모든 글자 조합이 4.5:1 이상인지, `lineStrong`이 면과 바탕에 대해 3:1 이상인지 다시 잰다.
3. `logoBackground`·`logoOutline`·`onLogoBackground`는 **바꾸지 않는다.** Google 공식 이미지가 테마를 따라 바뀌지 않으므로, 다른 제공자의 칩도 같은 흰 칩으로 남아야 한다.
4. 테마를 고르는 방법(시스템 설정 따르기, 사용자 선택)은 그때 정한다. 지금은 `PageLayout`의 `theme` prop만 있다.

## 3. 색

역할별로 쓴다. 화면 코드에 색 값을 직접 쓰지 않는다(예외: 제공자 로고 파일 안의 브랜드 색).

| 역할 | 밝은 테마 값 | 쓰임 |
| -- | -- | -- |
| `canvas` | `#EDF0EC` | 페이지 바탕. 차가운 회녹색 |
| `surface` | `#FBFCFA` | 목록 면, 카드, 알림 |
| `surfaceHover` | `#F2F5F2` | 면 hover |
| `surfacePressed` | `#E6EBE7` | 면 누름 |
| `surfaceSunken` | `#E1E6E2` | quiet 버튼 hover, 비활성 버튼 |
| `ink` | `#18302B` | 본문 글자, 제목. 짙은 솔잎색 |
| `inkSecondary` | `#46574F` | 보조 글자(설명, 이메일) |
| `inkMuted` | `#56655F` | 가장 옅은 글자(날짜, 준비 중 제공자) |
| `line` | `#CBD3CE` | 면 테두리, 목록 구분선(장식) |
| `lineStrong` | `#7B8A84` | 누를 수 있는 것의 외곽선(secondary 버튼, 바로가기 카드) |
| `accent` | `#0B5B53` | 누를 수 있는 것. 짙은 청록 |
| `accentHover` | `#053E37` | accent hover |
| `accentPressed` | `#032A25` | accent 누름 |
| `accentSoft` | `#D9E8E3` | 프로필 첫 글자 바탕 등 옅은 accent 면 |
| `onAccent` | `#FFFFFF` | accent 위 글자 |
| `danger` | `#A12F1C` | 문제가 생긴 것. 벽돌색 |
| `dangerSoft` | `#F7E4DE` | 옅은 danger 면 |
| `focusRing` | `#18302B` | 키보드 포커스 링(ink와 같음) |
| `skeletonBase` | `#C6CFC9` | 자리 표시 막대 |
| `skeletonHighlight` | `#D9E0DB` | 자리 표시 반짝임 |
| `logoBackground` | `#FFFFFF` | 로고 칩 바탕(모든 테마 고정) |
| `logoOutline` | `#747775` | 로고 칩 테두리(Google 공식 이미지에서 잰 값, 모든 테마 고정) |
| `onLogoBackground` | `#18302B` | 칩 위 단색 마크(모든 테마 고정) |

### 잰 명암비

검토 때 실제로 잰 값이다. 조합을 바꾸면 다시 잰다.

| 조합 | 명암비 | 기준 |
| -- | -- | -- |
| `ink` / `canvas` | 12.2:1 | 본문 4.5:1 |
| `inkSecondary` / `surface` | 7.46:1 | 본문 4.5:1 |
| `inkMuted` / `canvas` | 5.34:1 | 본문 4.5:1 |
| `onAccent` / `accent` | 7.97:1 | 본문 4.5:1 |
| `accent` / `surface`(바로가기 제목) | 7.74:1 | 본문 4.5:1 |
| `danger` / `surface` | 6.94:1 | 본문 4.5:1 |
| `focusRing` / `canvas` | 12.2:1 | 비글자 3:1 |
| `lineStrong` / `surface`·`canvas` | 3:1 이상 | 컨트롤 외곽선 3:1 |
| `logoOutline` / `logoBackground` | 4.5:1 | 컨트롤 외곽선 3:1 |
| `onLogoBackground` / `logoBackground` | 14.0:1 | 비글자 3:1 |
| `line` / `surface` | 1.48:1 | 장식(뜻을 전하지 않음) |
| `skeletonBase` / `surface` | 1.55:1 | 장식(불러오는 중임을 알 수 있을 정도) |

`line`과 `skeletonBase`는 뜻을 전하지 않는 장식이라 3:1을 요구하지 않는다. 누를 수 있는 것의 경계에는 `lineStrong`을 쓴다.

## 4. 서체

- **IBM Plex Sans KR** 한 가족, 굵기 400·500·600. `@fontsource/ibm-plex-sans-kr`로 직접 호스팅한다(`sources/design-system/fonts.ts`). 외부 서체 CDN은 쓰지 않는다. 굵기마다 unicode-range로 나뉘어 있어 화면이 그리는 글자 묶음만 받는다.
- 고른 이유: 엔지니어링 도구용으로 만든 서체라 코드를 직접 짜는 사람의 도구와 결이 맞고, 한글과 라틴 글자가 한 가족이라 `GitHub로 계속하기`처럼 섞여도 톤이 같다. Outfit, Pretendard, Noto Sans KR 같은 흔한 기본값을 피했다.
- 대체 서체 순서: `'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`.
- 한국어 줄바꿈: `PageLayout`이 `word-break: keep-all`, `overflow-wrap: anywhere`를 준다. 긴 이메일처럼 끊을 곳이 필요한 문자열은 `<wbr>`로 끊을 자리를 준다.

### 크기 단계

고전 타이포 단계(14·16·18·21·24·36·60)를 따른다.

| 토큰 `fontSize` | 값 | `textStyle` | 굵기 | 행간 | 자간 | 쓰임 |
| -- | -- | -- | -- | -- | -- | -- |
| `display` | 40→60px(`clamp`) | `display` | 600 | 1.15 | -0.025em | 로그인 화면 서비스 이름. 한 화면에 하나 |
| `heading1` | 28→36px(`clamp`) | `heading1` | 600 | 1.35 | -0.012em | 화면 제목(`<이름>님, 안녕하세요`) |
| `heading2` | 24px | `heading2` | 600 | 1.35 | -0.012em | 구역 제목(`계정`, `연결된 로그인`) |
| `heading3` | 21px | `heading3` | 600 | 1.35 | -0.012em | 카드 제목 |
| `lead` | 18px | `lead` | 400 | 1.7 | 0 | 소개 문장, 큰 버튼 글자 |
| `body` | 16px | `body` | 400 | 1.7 | 0 | 본문 |
| `body` | 16px | `label` | 500 | 1.45 | 0 | 버튼·메뉴·목록 항목 이름 |
| `small` | 14px | `small` | 400 | 1.45 | 0 | 날짜, 보조 설명 |

- `clamp`는 너비 360px에서 1280px 사이에 커진다.
- 제목은 `text-wrap: balance`로 줄 길이를 고르게, 본문은 `text-wrap: pretty`로 마지막 줄에 한 단어만 남지 않게 한다.
- 한글은 라틴보다 행간이 넉넉해야 해서 본문 행간은 1.7이다.
- `styled` 템플릿에서는 `${textStyle.heading2};`처럼 객체를 그대로 끼워 쓴다.

## 5. 여백, 격자, 배치

### 여백 단계(`space`)

4px 격자, 9단계.

| 토큰 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
| -- | -- | -- | -- | -- | -- | -- | -- | -- | -- |
| 값 | 4px | 8px | 12px | 16px | 24px | 32px | 48px | 64px | 96px |

### 배치

- **왼쪽 정렬**이 기본이다. 가운데 카드 하나로 화면을 만들지 않는다.
- 내용 폭: `layout.contentMaxWidth` 72rem(1152px). 읽는 글 폭: `layout.readingMaxWidth` 38rem.
- 좌우 여백(`layout.gutter`): 360 이하 16px, 768 이상 32px, 1024 이상 48px.
- 넓은 화면에서는 두 칸으로 나눈다. 로그인 화면은 소개와 로그인 목록, 홈은 계정과 연결된 로그인. 아래 줄(바로가기 카드)은 위 두 칸의 경계에 맞춘다.
- 상단 바의 왼쪽 글자 시작(서비스 이름, 360에서 두 번째 줄의 첫 메뉴)과 오른쪽 글자 끝(`로그아웃`)은 본문 좌우 선에 맞춘다. 누르는 영역(44px)이 선 밖으로 나가더라도 **글자**를 선에 맞춘다.

### 너비 기준(`media`)

| 토큰 | 조건 | 뜻 |
| -- | -- | -- |
| (없음) | 기본 | 360px 휴대폰 배치, 한 칸 |
| `media.medium` | `min-width: 48rem`(768px) | 두 칸 시작, 메뉴가 서비스 이름 옆 한 줄 |
| `media.large` | `min-width: 64rem`(1024px) | 여백 48px |
| `media.extraLarge` | `min-width: 80rem`(1280px) | 가장 넓은 배치 |
| `media.reducedMotion` | `prefers-reduced-motion: reduce` | 움직임 멈춤 |
| `media.forcedColors` | `forced-colors: active` | 고대비 모드에서 시스템 색 |
| `media.hover` | `hover: hover` | hover 스타일은 이 안에만(터치에서 hover가 남지 않게) |

360·768·1280 어느 너비에서도 가로 스크롤이 생기면 안 된다(`scrollWidth === clientWidth`).

## 6. 크기, 모서리, 그림자

### 크기(`size`)

| 토큰 | 값 | 뜻 |
| -- | -- | -- |
| `touchTarget` | 44px | 누를 수 있는 모든 것의 최소 너비·높이 |
| `controlLarge` | 56px | 큰 버튼 높이(로그인 버튼) |
| `listRow` | 60px | 목록 한 행 = `touchTarget` + 위아래 `space[2]`. 버튼이 든 행과 글자만 있는 행이 같은 높이 |
| `iconRegular` | 20px | 기본 아이콘·로고, 칩 안의 마크 |
| `iconLarge` | 24px | 큰 아이콘 |
| `logoChip` | 40px | 로그인 버튼 안 로고 칩 |
| `avatarSmall` / `avatarLarge` | 32px / 72px | 상단 바 / 계정 구역 프로필 |
| `borderWidth` | 1px | 모든 테두리 |
| `focusRingWidth` / `focusRingOffset` | 3px / 2px | 포커스 링 |
| `currentIndicator` | 3px | 상단 메뉴의 현재 페이지 막대 두께 |

### 모서리(`radius`)

| 토큰 | 값 | 쓰임 |
| -- | -- | -- |
| `control` | 6px | 누르는 것(버튼) |
| `logoChip` | 4px | 로고 칩(Google 공식 이미지의 모서리: @4x 16px → 4px) |
| `container` | 10px | 담는 면(목록 면, 바로가기 카드, 알림) |
| `round` | 50% | 프로필 사진만 |

같은 무게의 면끼리 모서리를 섞지 않는다. 목록 면과 바로가기 카드는 둘 다 `container`다.

### 그림자(`shadow`)

`shadow.floating` 하나뿐이고 **떠 있는 알림에만** 쓴다. 면과 카드는 그림자 대신 테두리로 구분한다.

## 7. 움직임

| 토큰 `duration` | 값 | 쓰임 |
| -- | -- | -- |
| `quick` | 120ms | hover·누름의 색 전환 |
| `moderate` | 200ms | 알림 나타남 |
| `slow` | 320ms | (예비) |
| `meterCycle` | 1100ms | 복귀 처리 중 진행 표시(오디오 레벨 미터) 한 주기 |
| `shimmerCycle` | 1600ms | 자리 표시 반짝임 한 주기 |

- 곡선(`easing`): `standard` `cubic-bezier(0.2, 0, 0, 1)`, 나가는 움직임 `exit` `cubic-bezier(0.4, 0, 1, 1)`.
- **저절로 움직이는 것은 두 가지뿐**이다: 복귀 처리 중 진행 표시, 자리 표시의 느린 반짝임. 나머지는 사용자 동작(hover, 누름, 알림 등장)에 답하는 움직임이다.
- **reduced motion**: 컴포넌트는 `duration.*`(변수)를 쓴다. `prefers-reduced-motion: reduce`에서는 모든 `--underview-duration-*`이 `0ms`가 되어 전환이 사라지고, 반복 애니메이션은 멈춘 모양으로 바뀐다. `durationValue`(원래 값)는 `keyframes` 주기처럼 변수를 쓸 수 없는 곳에만 쓰고, 그때는 `media.reducedMotion` 안에서 애니메이션을 끈다.

## 8. 컴포넌트

모두 `sources/design-system/components/`에 있다. 화면은 이것과 토큰만 쓴다.

### `PageLayout`

화면의 뼈대. 세 화면은 모두 이것으로 감싼다.

```tsx
<PageLayout header={<TopBar … />} arrangement="flow">…</PageLayout>
```

| prop | 뜻 |
| -- | -- |
| `header?` | `main` 위에 그린다(보통 `TopBar`). 있으면 `본문으로 건너뛰기` 링크를 더한다 |
| `arrangement?` | `flow`(기본, 위에서부터), `vertically-centered`(같은 왼쪽 선, 세로 가운데 — 헤더 없는 짧은 화면), `centered`(좁은 칸, 가로세로 가운데) |
| `theme?` | 지금은 `light`뿐 |

- `main` landmark(`id="main-content"`, `MAIN_CONTENT_ID`)를 제공한다. 안에서 `<main>`을 또 만들지 않는다.
- 서체를 불러오고, 테마 변수를 선언하고, 마운트된 동안에만 페이지 바탕을 칠한다(unmount하면 옛 화면의 바탕이 돌아온다).
- `NoticeRegion`을 자동으로 그린다.
- 첫 화면 검은 비침 방지: `index.html`이 이 레이아웃을 쓰는 경로에서 스크립트보다 먼저 `<html>`에 `data-underview-canvas` 속성을 달고 `canvas` 색을 칠한다. `PageLayout`이 마운트되면 이 속성을 지운다. 인라인 스타일의 색 값은 테스트가 `lightTheme.color.canvas`와 같은지 확인한다.

### `TopBar`와 `TopBarAccount`

```tsx
<TopBar
  serviceName="Audio Underview"
  homePath="/home"
  navigationLabel="주 메뉴"
  navigationItems={[{ label: '홈', path: '/home' }, …]}
  trailing={<TopBarAccount name={…} pictureURL={…} signOutLabel="로그아웃" onSignOut={…} />}
/>
```

- `header`와 `nav`(aria-label) landmark를 그린다. 메뉴는 `NavLink`라 현재 페이지에 `aria-current="page"`가 붙는다.
- 현재 페이지: 굵기 600·`ink` 글자와 글자 폭만큼의 3px 막대. 나머지 메뉴는 400·`inkSecondary`.
- 768 미만에서는 메뉴가 두 번째 줄로 내려간다. 메뉴 항목은 최소 44×44이고 글자는 왼쪽부터 시작한다.
- `TopBarAccount`: 프로필(사진 또는 이름 첫 글자), 이름, `로그아웃`(quiet 버튼). 768 미만에서는 이름을 눈에서만 숨긴다(스크린 리더는 읽는다).

### `Button`

```tsx
<Button variant="primary" size="large" leading={<ProviderLogoChip provider="google" />} fullWidth>
  Google로 계속하기
</Button>
```

| prop | 값 |
| -- | -- |
| `variant?` | `primary`(기본) · `secondary` · `quiet` |
| `size?` | `regular`(최소 44px) · `large`(56px) |
| `leading?` | 글자 앞 요소(장식, `aria-hidden`) |
| `fullWidth?` | 폭을 채우고 내용은 왼쪽 정렬 |
| 그 밖 | `<button>` 속성 전부. `type` 기본값은 `button` |

| variant | 기본 | hover | 누름 | 쓰임 |
| -- | -- | -- | -- | -- |
| `primary` | `accent` 채움, `onAccent` 글자 | `accentHover` + 글자 밑줄 | `accentPressed` | 화면의 주된 행동(로그인 시작) |
| `secondary` | `surface` + `lineStrong` 외곽선 | `surfaceHover` + `ink` 외곽선 | `surfacePressed` | 보조 행동(`다시 시도`) |
| `quiet` | 투명, `inkSecondary` 글자 | `surfaceSunken`, `ink` 글자 | `surfacePressed` | 드러나지 않아야 하는 행동(`로그아웃`) |

- 비활성: `surfaceSunken` 바탕, `inkMuted` 글자.
- hover는 `media.hover` 안에서만 적용한다. 같은 버튼 두 개가 나란할 때 hover한 쪽이 구분되도록 채움 한 단계 + 밑줄을 함께 쓴다.
- 큰 버튼 안에 로고 칩이 있으면 칩이 버튼의 시작·위·아래 가장자리에서 똑같이 8px 떨어지도록 시작 여백을 줄인다(`:has()` 규칙).
- 고대비 모드에서는 외곽선이 `ButtonText`다.

### `ProviderLogo`, `ProviderLogoChip`, `PROVIDER_LOGOS`

- `PROVIDER_LOGOS`(`sources/design-system/provider-logos.ts`): 제공자마다 공식 마크를 그리는 방법. `Record<OAuthProviderID, …>`라서 제공자 id가 늘면 로고를 더할 때까지 typecheck가 실패한다.
  - `fontawesome`: FontAwesome brands의 단색 마크. 글자 색을 따른다.
  - `mask`: 로컬 SVG를 마스크로 쓰는 단색 마크(Naver — FontAwesome에 없음. 다른 글리프와 무게가 맞도록 viewBox에 여백을 둔 파일).
  - `tile`: 제공자가 만든 완성 이미지. 다시 칠하지 않는다(Google).
- `<ProviderLogo provider="github" size="regular" />`: 20px(`regular`) 또는 24px(`large`). 목록·계정 줄에서 쓴다.
- `<ProviderLogoChip provider="google" />`: 로그인 버튼 안 40px 칩. Google은 공식 이미지를 그대로, 다른 제공자는 흰 칩(`logoBackground`) + 1px `logoOutline` 테두리 + 4px 모서리 + 가운데 20px 마크(`onLogoBackground`)로 그 이미지와 같게 맞춘다(1 + 9 + 20 + 9 + 1). hover·focus·누름에서도 칩은 바뀌지 않는다.

### `ProfileImage`

`<ProfileImage name="김하늘" pictureURL={…} size="large" />`. 사진이 없거나 불러오지 못하면 이름 첫 글자를 `accentSoft` 원 위에 `accent`로 그린다. `small` 32px, `large` 72px.

### `Skeleton`과 `LoadingPlaceholder`

- `<Skeleton shape="text" width="medium" textSize="small" />`: 모양 `text`·`block`·`circle`, 폭 `full`·`long`(75%)·`medium`(50%)·`short`(30%).
- `LoadingPlaceholder`(`label` 필수)가 자리 표시 묶음을 `role="status"`로 감싸 스크린 리더에 불러오는 중임을 알린다(예: `연결된 로그인을 불러오는 중입니다`).
- 자리 표시는 실제 내용과 **같은 높이**로 만든다. 데이터가 도착해도 아래 내용이 움직이지 않아야 한다.

### `ActivityIndicator`

오디오 레벨 미터 모양의 진행 표시. 장식이므로 `role="status"` 글자(예: `로그인하는 중입니다`)와 함께 쓴다. 크기 `text`(글자 높이) · `regular` · `large`.

### 알림: `NoticeRegion`과 `notice-store`

```ts
import { showNotice } from '../design-system/notice-store.ts';
showNotice({ title: '로그인 실패', description: '세션 토큰을 받지 못했습니다.' }); // tone 기본값 'error'
```

- `showNotice({ title, description?, tone? })`는 알림 id를 돌려준다. `tone`은 `error`(기본) · `information`. `dismissNotice(id)`, `clearNotices()`, `useNotices()`도 있다.
- `NoticeRegion`(`PageLayout`이 그린다): 화면 아래에 떠 있는 알림 목록(`aria-label="알림"`). 각 알림은 `role="alert"`이고, 닫기 버튼(`알림 닫기`)은 44px다.
- 8초(`noticeVisibleMilliseconds`) 뒤 스스로 닫힌다. 마우스가 올라가 있거나 포커스가 있는 동안은 멈춘다.
- 페이지를 옮겨도 알림이 이어지도록 스토어는 컴포넌트 밖에 있다(실패 처리 뒤 `/sign/in`으로 가면서 알림을 보여 줄 수 있다).

### 그 밖

- `Icon`: FontAwesome 아이콘을 20·24px로 그린다(장식, `aria-hidden`).
- `VisuallyHidden`: 눈에서만 숨기는 `span`.
- `styles.ts`
  - `focusRing`: `:focus-visible`일 때 3px `focusRing` 외곽선, 2px 간격. 포인터 클릭에는 보이지 않는다. 누를 수 있는 모든 새 요소에 넣는다.
  - `visuallyHidden`: `VisuallyHidden`과 같은 규칙.
  - `linkReset`: 새 디자인으로 만드는 링크에서 옛 `global.scss`의 링크 규칙(아래 테두리, hover 색)을 지운다. **주의**: hover 때 `border-bottom: 0`을 주므로, 테두리가 있는 카드 링크는 자기 `&:hover`에서 아래 테두리를 다시 지정해야 한다(바로가기 카드의 hover 때 아래 테두리가 사라진 적이 있다).

## 9. 제공자 로고 규칙

- **공식 마크만** 쓴다. 직접 그리거나 모양을 바꾸지 않는다.
- 로그인 화면에서 제공자는 **버튼 모양 하나**로 통일하고 로고로 구분한다. 제공자 브랜드 색으로 버튼을 칠하지 않는다.
- 누를 수 있는(`available`) 제공자가 화면의 주된 행동이다. 준비 중(`preparing`) 제공자는 버튼이 아닌 목록 항목(`inkMuted` 글자, 단색 로고)으로 그보다 덜 눈에 띄게 둔다.

### Google

[Google 브랜드 규정](https://developers.google.com/identity/branding-guidelines)을 따른다.

- 규정이 금지하는 것: 단색 G, 직접 만든 아이콘, **옛 G**(네 가지 색 평면 G), 표준 G를 밝음·어두움·중립이 아닌 색 바탕에 두기.
- 쓰는 것: 규정 페이지의 `signin-assets.zip` 중 `Android + Web/PNG @4x/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web@4x.png`. 흰 둥근 사각형 위에 현재 표준인 그라디언트 G가 있는 160×160 이미지다.
  - 저장소 파일: `sources/design-system/logos/google.png`, 바이트 그대로(SHA-256 `2bc2ae8e4c67de66d74bf1deed12cd8f22981270266a487576b671b0b4df361c`). 테스트가 이 해시를 확인한다.
  - 로그인 버튼: 40px 칩 자리에 이미지를 그대로. 따로 흰 바탕을 칠하지 않는다.
  - 홈 화면(연결된 로그인, `Google로 로그인함`): 같은 이미지를 20px로.
- 이미지를 바꿔야 하면(규정 개정) 같은 자산 묶음에서 다시 받아 파일만 바꾸고, 해시와 칩 수치(모서리, 테두리 색)를 다시 잰다.

### 제공자를 더할 때

1. `sign-provider`의 `OAuthProviderID`에 id가 늘면 `PROVIDER_LOGOS`와 로그인 상태 상수(`sources/constants/provider-statuses.ts`)가 typecheck에서 실패한다.
2. FontAwesome brands에 공식 마크가 있으면 `fontawesome`, 없으면 공식 SVG를 `logos/`에 두고 `mask`, 제공자가 완성 이미지를 요구하면 `tile`.
3. 새 마크가 다른 글리프보다 무거워 보이면(꽉 찬 사각형 등) viewBox 여백으로 광학 크기를 맞춘다.

## 10. 접근성

새 화면은 아래를 모두 지킨다. 검토 때 실제로 잰다.

- **명암**: 글자 4.5:1 이상, 컨트롤 경계·포커스 링 3:1 이상([잰 명암비](#잰-명암비)).
- **누르는 대상**: 44×44px 이상(`size.touchTarget`). 메뉴 항목, `로그아웃`, 알림 닫기, `다시 시도` 모두.
- **키보드**: 모든 동작을 키보드로 할 수 있다. 포커스 순서는 화면 순서와 같다(건너뛰기 링크 → 서비스 이름 → 메뉴 → 로그아웃 → 본문). 포커스는 `focusRing`(3px ink)으로 항상 보인다.
- **구조**: `header`·`nav`·`main` landmark, 화면마다 `h1` 하나와 순서 있는 제목 단계. 헤더가 있는 화면에는 `본문으로 건너뛰기`.
- **알림과 상태**: 알림은 `role="alert"`, 불러오는 중·처리 중은 `role="status"` 글자.
- **움직임**: `prefers-reduced-motion: reduce`에서 전환 0, 반복 애니메이션 정지.
- **고대비**: `forced-colors`에서 시스템 색(`ButtonText`, `LinkText`)으로 경계가 보인다.
- **언어**: `index.html`의 `lang="ko"`.
- **장식**: 로고·아이콘·진행 표시는 `aria-hidden`/`alt=""`. 제공자 이름은 옆 글자가 전한다.
- **준비 중 제공자**: 버튼이 아니고 포커스를 받지 않는다. 묶음 제목 `준비 중인 로그인`이 눈에 보이는 안내이고, 항목마다 `준비 중`을 스크린 리더용으로 붙인다.

## 11. 상태

모든 상태를 디자인하고 검토한다.

| 화면 | 상태 |
| -- | -- |
| 로그인 | 기본, 버튼 hover·focus·누름, 워커 설정 없음(오류 알림), 복귀 실패 뒤 돌아온 경우(오류 알림) |
| 복귀 처리 | 처리 중(`로그인하는 중입니다` + 진행 표시) |
| 홈 | 불러오는 중(자리 표시 1행), 목록, 빈 목록(`연결된 로그인이 없습니다`), 실패(`연결된 로그인을 불러오지 못했습니다` + `다시 시도`), 401(로그아웃 후 로그인 화면 + 알림) |

- **배치가 흔들리지 않게**: `연결된 로그인` 면은 최소 한 행(`listRow`) 높이를 잡는다. 불러오는 중·빈 목록·실패·연결 1개가 같은 높이라 아래 `바로가기`가 움직이지 않는다. 2개 이상이면 늘어난다.
- 오류 상태는 무엇이 잘못됐고 어떻게 하면 되는지 말한다(`다시 시도` 버튼을 같은 행에).

## 12. 문구

- 화면 글은 모두 한국어다. 서비스 이름 `Audio Underview`와 제공자 이름만 원래 표기를 쓴다.
- 쓰는 사람의 말로, 능동형으로. 버튼은 일어날 일을 말한다(`Google로 계속하기`, `다시 시도`, `로그아웃`).
- 명세에 정해진 문구는 글자 그대로 쓴다(`documents/migration/04-web-sign-in-and-home.md` §3~§5).
- 오류는 사과하지 않고, 무엇이 잘못됐는지 분명히 말한다.
- **바깥에서 온 글을 서비스 목소리로 보여 주지 않는다.** URL 쿼리나 외부 응답의 문자열(예: OAuth의 `error_description`)은 누구나 넣을 수 있어 서비스 이름을 단 임의 문구가 된다(CWE-451). 코드 값을 정해 둔 고정 문구로 바꿔 보여 주고, 원문은 로그에도 남기지 않는다.
- 토큰, 사용자 정보는 알림·로그 어디에도 넣지 않는다.

## 13. 옛 스타일과의 공존

새 화면과 옛 화면이 한 앱에 함께 있다. 옛 화면이 새 디자인으로 옮겨 올 때까지 아래를 지킨다.

- `sources/styles/global.scss`의 기존 변수와 옛 공용 컴포넌트(`PageHeader`, `NavigationLinks`, `UserAvatar`, `SignInButtons` 등)는 **지우거나 고치지 않는다.** 새 화면은 쓰지 않는다.
- 새 디자인 시스템은 모든 값을 `--underview-*` 변수와 `PageLayout` 루트 안에 가둔다. 옛 화면에는 새지 않는다.
- `global.scss`의 전역 규칙(링크 테두리·hover 색, `html, body` 어두운 바탕)이 새 화면에 스며드는 곳은 `linkReset`, `PageLayout`의 바탕 칠하기, `index.html`의 `data-underview-canvas`로 막는다.
- `index.html`의 Outfit Google Fonts 링크는 옛 화면이 쓰므로 남긴다. 새 화면은 쓰지 않는다.
- 옛 화면을 옮길 때: 그 화면을 `PageLayout`으로 감싸고 토큰·새 컴포넌트만 쓰게 한 뒤, 더는 쓰는 곳이 없는 옛 컴포넌트와 `global.scss` 변수를 지운다. 마지막 옛 화면이 옮겨지면 Outfit 링크와 `linkReset`의 옛 규칙 무효화도 지운다.

## 14. 검토 절차

새 화면이나 큰 변경은 스크린샷으로 검토한다.

1. 개발 서버를 환경변수를 명령에 직접 줘서 띄운다. `.env`를 만들거나 읽지 않는다.
   ```bash
   VITE_GOOGLE_CLIENT_ID=local \
   VITE_GOOGLE_OAUTH_WORKER_URL=https://google.example \
   VITE_GITHUB_OAUTH_WORKER_URL=https://github.example \
   pnpm --filter @audio-underview/web exec vite --port 5299 --strictPort
   ```
2. Playwright(`@playwright/test`, web의 devDependency)로 너비 360·768·1280에서 모든 상태를 찍는다.
   - 로그인 상태: 페이지를 열기 전에 `localStorage['sign-provider-auth']`에 `{ user, credential, expiresAt }`를 넣는다.
   - `/accounts`: `page.route('https://google.example/accounts', …)`로 성공·지연(불러오는 중)·500(실패)을 만든다.
   - 복귀 처리 중: 처리가 바로 끝나므로 `history.replaceState`를 막는 init script로 화면을 붙잡아 찍는다.
   - 스크린샷은 저장소 밖에 둔다.
3. 스크린샷을 직접 열어 보고 문제를 5개 이상, 화면·너비·위치를 짚어 적는다(정렬, 간격, 위계, 명암, 줄바꿈, 넘침, 포커스, 누르는 대상, 흔한 기본값).
4. 수치로 확인한다: 너비마다 `scrollWidth === clientWidth`, 누르는 대상 44px, reduced motion에서 전환·애니메이션 0개, 명암비.
5. 고친 뒤 다시 찍는다. 한 번 이상.

## 15. 새 화면 체크리스트

- [ ] `PageLayout`으로 감쌌고, 안에서 `<main>`을 만들지 않았다.
- [ ] 색·px 값을 직접 쓰지 않고 토큰만 썼다.
- [ ] 누를 수 있는 새 요소에 `focusRing`을 넣었고 44px 이상이다.
- [ ] 새로 만든 링크에 `linkReset`을 넣었다(테두리 있는 카드는 hover 아래 테두리를 다시 지정).
- [ ] hover 스타일은 `media.hover` 안에 있다.
- [ ] 움직임은 `duration` 변수를 쓰고 reduced motion에서 멈춘다.
- [ ] 모든 상태(불러오는 중, 빈 목록, 실패)를 만들었고, 상태가 바뀌어도 아래 내용이 움직이지 않는다.
- [ ] 문구는 한국어이고, 바깥에서 온 문자열을 그대로 보여 주지 않는다.
- [ ] 360·768·1280에서 스크린샷으로 검토했고 가로 스크롤이 없다.
