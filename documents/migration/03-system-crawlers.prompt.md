# 작업: 시스템 크롤러 · 이름 호출

메인 체크아웃(브랜치 `main`)에서 작업한다. `documents/migration/03-system-crawlers.md`를 전문 읽고, 그 명세대로 구현한다. 명세 밖의 브랜치·커밋·파일은 참고하지 않는다. 명세가 모호하거나 메인 코드와 맞지 않으면 임의로 정하지 말고 멈춰서 보고한다.

## 브랜치·커밋

- 브랜치 `feature/system-crawlers`.
- 첫 커밋은 문서 세 개(`03-system-crawlers.md`·`03-system-crawlers.sql`·`03-system-crawlers.prompt.md`)만: `document: add the system crawler design`.
- 작업 커밋: `feature: add system crawlers and run a crawler by name`.
- 커밋, feature 브랜치 push, draft PR 생성까지 한다. main push·merge·draft 해제·배포는 하지 않는다.
- `git add`는 파일 이름을 지정해서만 한다. 루트의 `production-oauth-secrets.env`는 읽지도 커밋하지도 않는다.
- PR: `gh pr create --draft --base main --title "feature: add system crawlers and run a crawler by name"`. 본문에 완료 판정 결과를 적는다.
- CI가 RED면 고쳐서 push한다. CodeRabbit 지적은 보고에 옮기고 HIGH만 반영한다.

## 실행 방식 — dynamic workflow agent team (opus 5.5 and sonnet 5 only)

모든 `agent()`에 `model: 'opus'` 또는 `model: 'sonnet'`을 명시한다. 생략(세션 모델 상속) 금지, fable 금지. 오케스트레이터(너)는 코드를 쓰지 않고 지시·통합·검증·커밋·보고만 한다.

| 레인 | 파일 소유 | 명세 | `model` | `effort` | `schema` |
| -- | -- | -- | -- | -- | -- |
| A | `packages/supabase-connector/**` | 03 §3, §5, §7 connector | `'opus'` | 생략 | `LANE_SCHEMA` |
| B | `functions/crawler-code-runner-function/**` | 03 §2, §4, §7 code runner | `'opus'` | 생략 | `LANE_SCHEMA` |
| C | `workers/crawler-manager-worker/**` | 03 §6, §7 crawler-manager | `'opus'` | 생략 | `LANE_SCHEMA` |
| D 검증 | 수정 없음 | 아래 검증 항목 | `'opus'` | `'high'` | `VERIFY_SCHEMA` |
| 수정(HIGH만) | 해당 파일 | — | `'opus'` | 생략 | `LANE_SCHEMA` |
| 재검증 | 수정 없음 | 검증 항목 | `'opus'` | `'high'` | `VERIFY_SCHEMA` |

A가 먼저다. B의 테스트는 A가 복사한 마이그레이션 파일을 읽고, C는 A의 export를 쓴다. A 다음에 B와 C를 병렬로 돌리고, D는 마지막이다. 레인 프롬프트에는 03의 해당 절 전문을 그대로 넣는다. `label`과 `phase`를 항상 지정한다.

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
phase('Connector')
const laneA = await agent(`${COMMON}\n${LANE_A_TASK}`, { label: 'lane-a:connector', phase: 'Connector', model: 'opus', schema: LANE_SCHEMA })
if (!laneA || laneA.status !== 'done') return { outcome: 'aborted', laneA }

phase('Implement')
const [laneB, laneC] = await parallel([
  () => agent(`${COMMON}\n${LANE_B_TASK}`, { label: 'lane-b:code-runner', phase: 'Implement', model: 'opus', schema: LANE_SCHEMA }),
  () => agent(`${COMMON}\n${LANE_C_TASK}`, { label: 'lane-c:crawler-manager', phase: 'Implement', model: 'opus', schema: LANE_SCHEMA }),
])
if (!laneB || !laneC || laneB.status !== 'done' || laneC.status !== 'done') return { outcome: 'aborted', laneA, laneB, laneC }

phase('Verify')
const verification = await agent(VERIFY, { label: 'verify', phase: 'Verify', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA })
const high = (verification?.findings ?? []).filter((finding) => finding.severity === 'HIGH')
if (verification?.verdict === 'GREEN' && high.length === 0) return { outcome: 'GREEN', laneA, laneB, laneC, verification }

phase('Fix')
const fix = await agent(`${COMMON}\nFIX ROUND — fix every HIGH, nothing else:\n${JSON.stringify(high, null, 2)}`, { label: 'fix:high', phase: 'Fix', model: 'opus', schema: LANE_SCHEMA })
const recheck = await agent(`${VERIFY}\nRE-CHECK after a fix round. Fix agent reported: ${JSON.stringify(fix?.notes ?? 'unavailable')}.`, { label: 'verify:recheck', phase: 'Fix', model: 'opus', effort: 'high', schema: VERIFY_SCHEMA })
return { outcome: recheck?.verdict ?? 'RED', laneA, laneB, laneC, verification, fix, recheck }
```

`COMMON`에 넣을 것:
- 작업 디렉터리 절대 경로와 브랜치
- 파일 소유 범위
- 03 명세만 보고 구현한다는 규칙
- 마이그레이션 파일은 `cp`로 복사하고 내용을 고치지 않는다는 규칙
- git 쓰기·배포·시크릿 읽기 금지
- `package.json`은 고치지 않는다(의존성 추가 없음)
- 저장소 규약: `.ts` 확장자 import, `??`, 줄임말 금지
- 실제로 실행한 검증 명령과 수치를 보고할 것
- "Your final message is machine-read; follow the schema."

## 검증 항목 (레인 D, 고치지 말고 판정만)

1. `cmp documents/migration/03-system-crawlers.sql packages/supabase-connector/migrations/010_create_system_crawlers.sql`이 차이 없음.
2. 03의 값과 다른 곳이 없다. 대상은 요청 헤더 3개, `SYSTEM_USER_UUID`, 함수·메서드 시그니처, 오류 메시지다.
3. 03 §7의 테스트 항목마다 대응하는 테스트가 있다. `SYSTEM_CRAWLER_CASES` 14건이 전부 들어 있다.
4. 기존 export·라우트·RPC가 그대로다. 루트 `pnpm typecheck`와 세 패키지의 기존 테스트로 확인한다.
5. 이름 호출용 HTTP 라우트가 없고, 일반 사용자 크롤러를 이름으로 찾는 경로가 없다.
6. `package.json`과 `pnpm-lock.yaml`이 바뀌지 않았다.

## 완료 판정

```bash
pnpm install --frozen-lockfile
pnpm --filter @audio-underview/supabase-connector typecheck
pnpm --filter @audio-underview/supabase-connector test
pnpm --filter @audio-underview/crawler-code-runner-function typecheck
pnpm --filter @audio-underview/crawler-code-runner-function test
pnpm --filter @audio-underview/crawler-manager-worker typecheck
pnpm --filter @audio-underview/crawler-manager-worker test
pnpm typecheck
```

## 보고

1. 커밋 해시, 변경 파일 목록, draft PR URL, CI 결과.
2. 테스트·typecheck 실제 결과.
3. 검증 항목별 판정.
4. 명세가 모호했거나 메인 코드와 맞지 않은 곳. 없으면 "없음".
