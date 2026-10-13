# 작업: 웹 — 로그인 화면과 홈 화면 다시 만들기

메인 체크아웃(브랜치 `main`)에서 작업한다. `documents/migration/04-web-sign-in-and-home.md`를 전문 읽고, 그 명세대로 구현한다. 명세 밖의 브랜치·커밋·파일은 참고하지 않는다. 명세가 모호하거나 메인 코드와 맞지 않으면 임의로 정하지 말고 멈춰서 보고한다.

**디자인은 새로 만드는 것이 이 작업의 절반이다.** 지금 화면을 손보는 것이 아니다. 명세 §6을 요구사항으로 다룬다. 세션에 프런트엔드 디자인 스킬이 있으면 디자인 레인과 디자인 검토 레인이 먼저 그것을 불러서 따른다.

## 브랜치·커밋

- 브랜치 `feature/web-sign-in-and-home`.
- 첫 커밋은 문서 두 개(`04-web-sign-in-and-home.md`·`04-web-sign-in-and-home.prompt.md`)만: `document: add the sign-in and home screen design`.
- 작업 커밋: `feature(web): rebuild the sign-in and home screens with a new design`.
- 커밋, feature 브랜치 push, draft PR 생성까지 한다. main push·merge·draft 해제·배포는 하지 않는다.
- `git add`는 파일 이름을 지정해서만 한다. 루트의 `production-oauth-secrets.env`와 `.env*`는 읽지도 커밋하지도 않는다.
- PR: `gh pr create --draft --base main --title "feature(web): rebuild the sign-in and home screens with a new design"`. 본문에 디자인 방향 글(명세 §6)과 완료 판정 결과를 적는다.
- PR에 `/deploy:preview` 라벨을 붙인다. 미리보기 주소에서 로그인 화면을 볼 수 있다. 실제 로그인은 프로덕션 도메인과 `http://localhost:5173`에서만 된다(OAuth 워커의 허용 origin).
- CI가 RED면 고쳐서 push한다. CodeRabbit 지적은 보고에 옮기고 HIGH만 반영한다.

## 실행 방식 — dynamic workflow agent team (opus 5.5 and sonnet 5.5 only)

모든 `agent()`에 `model`을 명시한다. 생략(세션 모델 상속) 금지, fable 금지. Workflow의 `'sonnet'` 별칭은 Sonnet 5로 풀리므로 쓰지 않는다. 이 작업의 레인은 전부 `model: 'opus'`다. 오케스트레이터(너)는 코드를 쓰지 않고 지시·통합·검증·커밋·보고만 한다.

| 레인 | 파일 소유 | 명세 | `effort` | `schema` |
| -- | -- | -- | -- | -- |
| A 디자인 기반 | 디자인 토큰 모듈, 새 공용 컴포넌트(상단 바, 버튼, 알림 등), `index.html` | 04 §2, §6 | 생략 | `LANE_SCHEMA` |
| B 로그인 | 로그인 화면, 복귀 처리, 상태 상수, `Application.tsx`, 그 테스트 | 04 §3, §4, §7 | 생략 | `LANE_SCHEMA` |
| C 홈 | 홈 화면, `/accounts` 훅, 그 테스트 | 04 §5, §7 | 생략 | `LANE_SCHEMA` |
| D 기능 검증 | 수정 없음 | 아래 검증 항목 | `'high'` | `VERIFY_SCHEMA` |
| E 디자인 검토 | 수정 없음. 스크린샷만 만든다 | 04 §6 검토 | `'high'` | `VERIFY_SCHEMA` |
| 수정 | 해당 파일 | D의 HIGH 전부, E의 지적 전부 | 생략 | `LANE_SCHEMA` |
| 재검증 | 수정 없음 | D와 E를 다시 | `'high'` | `VERIFY_SCHEMA` |

A가 먼저다. A는 디자인 방향 글과 토큰, 공용 컴포넌트를 만들고, 방향 글을 결과의 `notes`에 담는다. 그다음 B와 C를 병렬로 돌리고, 두 레인의 프롬프트에 A의 방향 글과 만든 컴포넌트 목록을 넣는다. D와 E는 그 뒤에 병렬로 돌린다. 수정과 재검증은 E가 문제를 하나도 못 찾을 때까지가 아니라 **최소 한 번** 한다. `label`과 `phase`를 항상 지정한다.

```js
const LANE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    files: { type: 'array', items: { type: 'string' } },
    testsPassed: { type: 'number' },
    notes: { type: 'string' },
  },
  required: ['status', 'files', 'testsPassed', 'notes'],
}
const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['GREEN', 'RED'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['severity', 'file', 'description'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['verdict', 'findings', 'summary'],
}
```

```js
phase('Foundation')
const laneA = await agent(`${COMMON}\n${LANE_A_TASK}`, { label: 'lane-a:design-foundation', phase: 'Foundation', model: 'opus', schema: LANE_SCHEMA })
if (!laneA || laneA.status !== 'done') return { outcome: 'aborted', laneA }

phase('Screens')
const foundation = `DESIGN DIRECTION AND SHARED PIECES FROM LANE A:\n${laneA.notes}\nFILES: ${laneA.files.join(', ')}`
const [laneB, laneC] = await parallel([
  () => agent(`${COMMON}\n${foundation}\n${LANE_B_TASK}`, { label: 'lane-b:sign-in', phase: 'Screens', model: 'opus', schema: LANE_SCHEMA }),
  () => agent(`${COMMON}\n${foundation}\n${LANE_C_TASK}`, { label: 'lane-c:home', phase: 'Screens', model: 'opus', schema: LANE_SCHEMA }),
])
if (!laneB || !laneC || laneB.status !== 'done' || laneC.status !== 'done') return { outcome: 'aborted', laneA, laneB, laneC }

phase('Review')
const [functional, design] = await parallel([
  () => agent(VERIFY, { label: 'verify:functional', phase: 'Review', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA }),
  () => agent(`${foundation}\n${DESIGN_REVIEW}`, { label: 'verify:design', phase: 'Review', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA }),
])
const toFix = [
  ...(functional?.findings ?? []).filter((finding) => finding.severity === 'HIGH'),
  ...(design?.findings ?? []),
]

phase('Fix')
const fix = await agent(`${COMMON}\n${foundation}\nFIX ROUND — fix every item below, nothing else:\n${JSON.stringify(toFix, null, 2)}`, { label: 'fix', phase: 'Fix', model: 'opus', schema: LANE_SCHEMA })
const [functionalRecheck, designRecheck] = await parallel([
  () => agent(`${VERIFY}\nRE-CHECK after a fix round.`, { label: 'verify:functional-recheck', phase: 'Fix', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA }),
  () => agent(`${foundation}\n${DESIGN_REVIEW}\nRE-CHECK after a fix round. Previous findings: ${JSON.stringify(design?.findings ?? [])}`, { label: 'verify:design-recheck', phase: 'Fix', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA }),
])
return { laneA, laneB, laneC, functional, design, fix, functionalRecheck, designRecheck }
```

`COMMON`에 넣을 것:
- 작업 디렉터리 절대 경로와 브랜치
- 파일 소유 범위
- 04 명세만 보고 구현한다는 규칙
- 다른 화면의 코드, 기존 공용 컴포넌트, `global.scss`의 기존 변수를 지우거나 고치지 않는다는 규칙
- git 쓰기·배포·시크릿 읽기 금지
- 의존성은 `pnpm add`로만. 서체처럼 디자인에 꼭 필요한 것만
- 저장소 규약: `.ts`·`.tsx` 확장자 import, `??`, 줄임말 금지
- 실제로 실행한 검증 명령과 수치를 보고할 것
- "Your final message is machine-read; follow the schema."

`DESIGN_REVIEW`에 넣을 것:
- 04 §6 전문
- 스크린샷 찍는 법(아래)
- 문제를 5개 이상, 화면·너비·위치를 짚어 구체적으로 적을 것. 찾은 문제는 전부 `findings`에 넣는다
- 스크린샷 파일 경로를 `summary`에 적을 것

**스크린샷 찍는 법**
- 개발 서버는 환경변수를 명령에 직접 줘서 띄운다. `.env`를 만들거나 읽지 않는다.
  ```bash
  VITE_GOOGLE_CLIENT_ID=local VITE_GOOGLE_OAUTH_WORKER_URL=https://google.example VITE_GITHUB_OAUTH_WORKER_URL=https://github.example pnpm --filter @audio-underview/web dev
  ```
- Playwright(이미 devDependency)로 너비 360·768·1280에서 찍는다.
- 홈 화면의 로그인 상태는 `localStorage['sign-provider-auth']`에 `{ user, credential, expiresAt }`를 넣어 만든다. `/accounts`는 Playwright의 `route`로 응답을 대신한다. 성공, 지연(불러오는 중), 500(실패)을 각각 만든다.
- 파일은 세션의 임시 폴더에 둔다. 저장소에 커밋하지 않는다.

## 검증 항목 (레인 D, 고치지 말고 판정만)

1. 04 §3~§5의 동작과 문구가 그대로다. 제공자 순서와 상태, 복귀 처리 순서, `/accounts` 요청과 상태별 화면, 로그아웃이 대상이다.
2. 04 §7의 테스트 항목마다 대응하는 테스트가 있다.
3. 복귀 처리가 `/authentication/token`을 부르지 않고, `access_token`으로 로그인하지 않는다. 토큰과 `user` 값이 로그에 남지 않는다.
4. 다른 화면의 코드, 기존 공용 컴포넌트, `global.scss`의 기존 변수가 그대로다(`git diff`로 확인).
5. 두 화면이 색 값과 px 값을 직접 쓰지 않고 토큰만 쓴다.
6. 의존성이 `pnpm add`로만 바뀌었고, UI 프레임워크가 추가되지 않았다.

## 완료 판정

```bash
pnpm install --frozen-lockfile
pnpm --filter @audio-underview/web typecheck
pnpm --filter @audio-underview/web lint
pnpm --filter @audio-underview/web test
pnpm --filter @audio-underview/web build
pnpm typecheck
```

`build`에는 `VITE_GOOGLE_CLIENT_ID`가 필요 없다. 환경 검증은 실행할 때 한다.

## 보고

1. 커밋 해시, 변경 파일 목록, draft PR URL, 미리보기 주소, CI 결과.
2. 디자인 방향 글.
3. 마지막 스크린샷 파일 경로. 세션에 파일을 사용자에게 보내는 도구가 있으면 그것으로 보낸다.
4. 디자인 검토에서 찾은 문제와 고친 내용.
5. 테스트·typecheck·lint·build 실제 결과와 검증 항목별 판정.
6. 명세가 모호했거나 메인 코드와 맞지 않은 곳. 없으면 "없음".
