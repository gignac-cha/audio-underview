# share-viewer

읽기 전용 공개 공유 뷰어. 완료된 뉴스캐스트 1개를 `/share/:token` permalink로
로그인 없이 감상하는 전용 앱입니다.

정본 설계: `documents/2026-10-26-newscast-form-template-web.md` (§4, §5)

## 왜 별도 앱인가

메인 웹(`applications/web`)과 코드를 공유하지 않습니다. 인증
컨텍스트·footprint·소유자 기능이 **숨겨진 게 아니라 존재하지 않는** 상태를
배포 단위로 보장하기 위해서입니다. 재생·싱크 로직은 메인 웹의
`NewscastFloatingPlayer.tsx` / `ScriptCaptions.tsx`에서 포팅(복사)했고, 앱 간
`sources` 직접 import는 하지 않습니다.

localStorage에 쓰는 키는 테마 1개(`audio-underview:share-viewer:theme`)뿐입니다.

## 구조

| 경로 | 역할 |
|---|---|
| `sources/playback/timings.ts` | 순수 타이밍 산술 (활성 라인·단어, 파트 경계 시킹) |
| `sources/playback/use-share-playback.ts` | 단일 `<audio>` 엘리먼트 상태 기계 (파트 이어재생·시그널 스팅) |
| `sources/schemas/public-share-view.ts` | `GET /share/:token` 응답 계약 (§4.1) |
| `sources/open-graph/share-metadata.ts` | OG/트위터 메타 문자열 조립 (순수 함수) |
| `functions/share/[token].ts` | Pages Function — 응답 시점 HTMLRewriter head 주입 |
| `sources/fixtures/` | 워커 배포 전 개발·테스트용 고정 payload |

### 파트-상대 오프셋

`segments[].startMs`와 `words[].startMs`는 **해당 파트 MP3 내부 오프셋**입니다.
전체 뉴스캐스트 타임라인이 아닙니다. 그래서 파트 경계를 넘는 시킹은 항상 2단계
입니다 — `src`를 대상 파트로 바꾸고, `loadedmetadata`가 오면 그때 파트-상대
오프셋을 적용합니다.

### OG는 왜 서버 주입인가

카톡·슬랙·디스코드 스크레이퍼는 JS를 실행하지 않습니다. 클라이언트가 그린
`<meta>`는 크롤러에 보이지 않으므로, Pages Function이 첫 응답의 `<head>`를
HTMLRewriter로 고쳐 씁니다. 무효 토큰은 같은 정적 HTML을 **HTTP 404**로 서빙해
SPA가 무효 링크 화면을 띄웁니다.

알려진 한계: 메신저가 OG 카드를 자체 캐시하므로, 링크 회수 후에도 미리보기가
한동안 남을 수 있습니다(본문은 즉시 404).

## 환경변수

| 이름 | 소비처 | 설정 위치 |
|---|---|---|
| `VITE_NEWSCAST_WORKER_URL` | 클라이언트 번들 (빌드 시) | `.env` (`.env.example` 참고) |
| `NEWSCAST_WORKER_URL` | Pages Function (런타임) | `functions/worker-url.generated.ts` |

Pages 환경 변수는 production과 preview 둘뿐이라 환경마다 다르게 둘 수 없습니다.
그래서 Function은 변수 대신 `functions/worker-url.generated.ts`를 읽습니다. 저장소에는
production 워커 주소가 들어 있고, `deploy-environment.yml`의 share-viewer job이
빌드 전에 그 환경의 뉴스캐스트 워커 주소로 다시 씁니다.

## 명령

```bash
pnpm dev        # 개발 서버
pnpm test       # vitest (jsdom)
pnpm typecheck  # 앱 + Pages Function 두 tsconfig
pnpm build      # typecheck 후 vite build → outputs/
```

Pages 프로젝트는 `audio-underview-share`입니다. production은 `deploy-share-viewer.yml`,
staging과 development는 `deploy-environment.yml`이 배포합니다.
`wrangler pages deploy`는 이 디렉터리에서 실행해야 `functions/`가 함께 컴파일됩니다.
