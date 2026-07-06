# Full Rewrite Analysis — audio-underview

> 작성일: 2026-07-06 / 기준: origin/main (worktree `refactor-rewrite-20260706`)
> 수집: Haiku subagent 6개 병렬 조사 결과 취합

## 1. 프로젝트 개요

**크롤러/스케줄러 관리 플랫폼.** 사용자가 웹 UI에서 크롤러 코드를 작성(Monaco editor)하고, 스케줄러로 다단계(stage) 실행을 오케스트레이션하는 시스템.

| 항목 | 값 |
|------|-----|
| 규모 | 249 TS/TSX files, ~31,093 lines |
| 구조 | pnpm workspace 5그룹 + Turbo 2.7 |
| 패키지 수 | 31개 (applications 1, packages 14, workers 12, functions 2, tools 1) |
| Node | ≥25.2.1 (native TypeScript 실행) |
| TypeScript | 5.9.3, strict mode 100% (tsconfig 23개) |
| TODO/FIXME | 2개 (기술부채 주석 거의 없음) |

### 라인 수 분포

| 영역 | 파일 | 라인 |
|------|------|------|
| workers | 66 | 11,570 |
| applications/web | 75 | 9,322 |
| packages | 98 | 8,767 |
| functions | 8 | 1,201 |
| tools | 2 | 233 |

## 2. 기술 스택

### Frontend (`applications/web`)
- React 19 + Vite 7 + React Router v7
- 상태관리: **Zustand + Recoil + Jotai 3개 혼재** ⚠️
- Radix UI + Emotion + clsx, TanStack Query v5, @dnd-kit, Monaco Editor, FontAwesome
- Zod 4 (검증), babel-plugin-react-compiler
- 테스트: Vitest + Testing Library (16개), Playwright E2E, MSW, Storybook 10

### Backend (Cloudflare)
- Workers 12개 (wrangler 4.56, compatibility date 2025-11-25)
  - Core 3: `crawler-manager`, `crawler-code-runner`, `scheduler-manager`
  - OAuth provider workers 8: apple, discord, facebook, github, google, kakao, microsoft, naver
  - `worker-tools` (공용)
- Pages Functions 2: `crawler-code-runner-function`, `function-tools`
- Storage: Supabase (Postgres, 주 DB), KV `AUDIO_UNDERVIEW_OAUTH_STATE` (OAuth state)
- Logging: Axiom (일부 worker만 — google, github)

### API 표면 (scheduler-manager-worker 기준)
- `/authentication/token` — OAuth token exchange
- `/schedulers` CRUD + `/stages` CRUD + reorder + `/runs` 조회 + `/execute`
- crawler-manager도 유사 CRUD 구조

### CI/CD (GitHub Actions 11개)
- test 4개 (functions/packages/web/workers), deploy 6개 (web/crawler-functions/crawler-workers/oauth-workers/scheduler-worker/database-migrations), preview 관리 1개

## 3. Agent 간 교차 검증 — 불일치/확인 필요 항목

| # | 항목 | 상세 |
|---|------|------|
| 1 | **OAuth 개수 불일치** | packages는 10개 (linkedin, x 포함), workers는 8개 (linkedin, x 없음). linkedin/x는 package만 있고 worker 미구현 상태로 추정 — 재작성 scope에 포함할지 결정 필요 |
| 2 | **ESLint config 부재?** | root devDeps에 eslint 9.39.2 + react plugins 존재하나 config 파일 미발견. flat config (`eslint.config.js`) 탐색 누락 가능성 — 재확인 필요 |
| 3 | **HANDOFF.md / AGENTS.md / documents/** | main checkout에만 untracked로 존재. worktree(=origin/main)에는 없음. 재작성 전 내용 확인 권장 |
| 4 | **"Next.js" 오보** | 문서 조사 agent가 Next.js라 했으나 실제는 Vite + React Router v7 |

## 4. 재작성 관점 핵심 발견

### 4.1 최대 감량 포인트: OAuth provider 반복 구조
- provider당 package 1개 + worker 1개 = **~20개 패키지가 거의 동일한 코드 반복**
- workers 11,570줄의 상당 부분이 이 반복
- 재작성 방향: **단일 OAuth worker + provider strategy 패턴** (또는 코드 생성)으로 통합하면 패키지 수 31 → ~12-15개로 축소 가능

### 4.2 상태관리 단일화
- Zustand + Recoil + Jotai 혼재. Recoil은 사실상 유지보수 중단 + React 19 호환 위험
- web package.json direct dep는 jotai — **Jotai로 단일화**가 자연스러움

### 4.3 대형 파일 분해 대상
1. `CrawlerEditorPage.tsx` — 831줄 (최근 split-pane 통합 작업의 결과물)
2. `SchedulersPage.tsx` — 475줄
3. `CrawlersPage.tsx` — 463줄

### 4.4 재활용 가능 자산
- **테스트 스위트가 풍부** (worker index.test.ts 550~820줄대) → 재작성 시 행위 계약(behavioral contract)으로 활용, API 호환 검증 가능
- CI 파이프라인 구조 (test 4 + deploy 6) 그대로 이식 가능
- wrangler 설정, KV/Supabase binding 구조 유지 가능

### 4.5 리스크
- 크롤러 code-runner의 worker/function 이중 구현 (`crawler-code-runner-worker` + `crawler-code-runner-function`) — 역할 구분 파악 후 통합 여부 결정 필요
- Axiom logging이 일부 worker에만 적용 — 재작성 시 일관화 기회

## 5. 제안 재작성 순서 (초안)

1. **Foundation** — workspace/turbo/tsconfig 골격 + shared tools (logger, supabase-connector, sign-provider)
2. **OAuth 통합** — 단일 provider-strategy worker로 재설계 (최대 감량)
3. **Core workers** — scheduler-manager → crawler-manager → code-runner (API 계약 = 기존 테스트)
4. **Web** — Jotai 단일화 + 페이지 분해, 라우트 구조 유지
5. **CI/CD** — 기존 workflow 이식 + 패키지 축소 반영
