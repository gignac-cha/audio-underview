# 작업: API 키 볼트 워커 · logger scrubber (Linear TES-135)

메인 체크아웃(브랜치 `main`)에서 작업한다. `documents/migration/02-vault.md`를 전문 읽고, 그 명세대로 구현한다. 명세 밖의 브랜치·커밋·파일은 참고하지 않는다. 명세가 모호하거나 메인 코드와 맞지 않으면 임의로 정하지 말고 멈춰서 보고한다.

## 브랜치·커밋

- 브랜치 `feature/api-key-vault-migration`.
- 첫 커밋은 문서 두 개(`02-vault.md`·`02-vault.prompt.md`)만: `document: add the API key vault design`.
- 작업 커밋: `feature: add the API key vault worker and the logger credential scrubber`.
- 커밋, feature 브랜치 push, draft PR 생성까지 한다. main push·merge·draft 해제·배포·시크릿 등록·D1 생성은 하지 않는다.
- `git add`는 파일 이름을 지정해서만 한다. 루트의 `production-oauth-secrets.env`는 읽지도 커밋하지도 않는다.
- 커밋 전 `git diff --cached`에서 두 가지를 grep으로 확인한다. 32자 hex 계정 id가 0건이어야 한다. 테스트 파일 밖에서 `sk-`·`ghp_`·`AIza`·`-----BEGIN`이 0건이어야 한다.
- PR: `gh pr create --draft --base main --title "feature: add the API key vault worker and the logger credential scrubber"`. 본문에 TES-135와 완료 판정 결과를 적는다.
- CI가 RED면 고쳐서 push한다. CodeRabbit 지적은 보고에 옮기고 HIGH만 반영한다.

## 실행 방식 — dynamic workflow agent team (opus 5.5 and sonnet 5 only)

모든 `agent()`에 `model: 'opus'` 또는 `model: 'sonnet'`을 명시한다. 생략(세션 모델 상속) 금지, fable 금지. 오케스트레이터(너)는 코드를 쓰지 않고 지시·통합·검증·커밋·보고만 한다.

| 레인 | 파일 소유 | 명세 | `model` | `effort` | `schema` |
| -- | -- | -- | -- | -- | -- |
| A (TES-140) | `packages/logger/**` | 02 §2 | `'opus'` | 생략 | `LANE_SCHEMA` |
| B (TES-141) | `workers/api-key-vault-worker/**` | 02 §3, §2.3 export | `'opus'` | 생략 | `LANE_SCHEMA` |
| C (TES-142) | 새 워크플로, `deployment-targets.ts` | 02 §4 | `'sonnet'` | 생략 | `LANE_SCHEMA` |
| D 검증 | 수정 없음 | 아래 검증 항목 | `'opus'` | `'high'` | `VERIFY_SCHEMA` |
| 수정(HIGH만) | 해당 파일 | — | `'opus'` | 생략 | `LANE_SCHEMA` |
| 재검증 | 수정 없음 | 검증 항목 | `'opus'` | `'high'` | `VERIFY_SCHEMA` |

A와 B는 병렬, C는 B 다음, D는 마지막. 레인 프롬프트에는 02의 해당 절 전문을 그대로 넣는다. `label`과 `phase`를 항상 지정한다.

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
phase('Implement')
const [laneA, laneB] = await parallel([
  () => agent(`${COMMON}\n${LANE_A_TASK}`, { label: 'lane-a:logger', phase: 'Implement', model: 'opus', schema: LANE_SCHEMA }),
  () => agent(`${COMMON}\n${LANE_B_TASK}`, { label: 'lane-b:vault', phase: 'Implement', model: 'opus', schema: LANE_SCHEMA }),
])
if (!laneA || !laneB || laneA.status !== 'done' || laneB.status !== 'done') return { outcome: 'aborted', laneA, laneB }

phase('Wire')
const laneC = await agent(`${COMMON}\n${LANE_C_TASK}`, { label: 'lane-c:deploy-wiring', phase: 'Wire', model: 'sonnet', schema: LANE_SCHEMA })
if (!laneC || laneC.status !== 'done') return { outcome: 'aborted', laneA, laneB, laneC }

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
- 02 명세만 보고 새로 쓴다는 규칙
- git 쓰기·배포·`wrangler` 원격 명령·시크릿 읽기 금지
- 의존성은 `pnpm init`·`pnpm add`로만
- 저장소 규약: `.ts` 확장자 import, `??`, 줄임말 금지
- 실제로 실행한 검증 명령과 수치를 보고할 것
- "Your final message is machine-read; follow the schema."

## 검증 항목 (레인 D, 고치지 말고 판정만)

1. 02의 값과 다른 곳이 없다. 대상은 정규식·플래그·순서, AAD 형식, 제공자 표, URL 거부·허용 예, 라우트 응답·오류, 스키마 DDL, `wrangler.toml`이다.
2. 02 §2.4·§3.11의 테스트 항목마다 대응하는 테스트가 있다.
3. 평문 키가 응답·로그·DB 컬럼 어디에도 없다.
4. `key_audit_log`에 `UPDATE`·`DELETE`가 없고, 감사 읽기가 해시 컬럼을 선택하지 않는다.
5. logger의 기존 export·시그니처가 그대로다. 루트 `pnpm typecheck`로 확인한다.
6. logger와 볼트가 `newscast-*`를 import하지 않는다.
7. `package.json` 의존성이 명령으로만 바뀌었다. lockfile과 일치해야 한다.

## 완료 판정

```bash
pnpm install
pnpm --filter @audio-underview/logger typecheck
pnpm --filter @audio-underview/logger test
pnpm --filter @audio-underview/api-key-vault-worker typecheck
pnpm --filter @audio-underview/api-key-vault-worker test
pnpm --filter @audio-underview/deployment-planner test
pnpm typecheck
```

다른 워크스페이스 테스트가 로그에 credential 모양 문자열이 그대로 찍히기를 기대해 실패하면, 기대값을 가려진 값으로 고치고 보고한다.

## 보고

1. 커밋 해시, 변경 파일 목록, draft PR URL, CI 결과.
2. 테스트·typecheck 실제 결과.
3. 검증 항목별 판정.
4. 명세가 모호했거나 메인 코드와 맞지 않은 곳. 없으면 "없음".
