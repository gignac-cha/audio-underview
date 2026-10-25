# 뉴스캐스트 1: 패키지와 provider 키 등록 (설계)

요구사항은 `documents/migration/08-newscast.md`, 이슈는 TES-264다. 작업 그룹(TES-265)과 공식 크롤러(TES-268)가 함께 쓰는 토대 중, 쓰는 곳 없이도 스스로 확인할 수 있는 두 가지를 먼저 만든다.

1. 뉴스캐스트 패키지 넷을 프로토타입 `ec5d226`에서 옮긴다.
2. 사용자가 웹에서 provider 키를 등록하고, 상태와 이력을 보고, 지운다.

뉴스캐스트 기록·공유 테이블은 그 테이블에 쓰는 그룹 워커와 함께 2번(TES-265)에서 만든다.

## 1. 패키지

### 대상

| main | 출처(`ec5d226`) |
| -- | -- |
| `packages/newscast-core` (`@audio-underview/newscast-core`) | `packages/newscast-core-prototype` |
| `packages/newscast-script` (`@audio-underview/newscast-script`) | `packages/newscast-script-prototype` |
| `packages/newscast-tts` (`@audio-underview/newscast-tts`) | `packages/newscast-tts-prototype` |
| `packages/newscast-audio` (`@audio-underview/newscast-audio`) | `packages/newscast-audio-prototype` |

- 커밋에 들어 있는 파일만 `git show ec5d226:<경로>`로 통째로 옮긴다. 무시 대상(`capture-baseline.ts`, `experiments/`, `.turbo/`)은 옮기지 않는다.
- `package.json`은 `pnpm init`으로 만들고, 의존성이 아닌 필드만 프로토타입과 같게 적는다.
  - 같게 적는 필드: `version`, `private`, `type`, `main`, `types`, `exports`, `scripts`
  - script의 `./verbatim-script.ts` export도 포함한다.
- 의존성은 `pnpm add`로만 넣는다.
  - script, tts, audio: `@audio-underview/newscast-core@workspace:*`
  - audio: `@breezystack/lamejs@^1.2.7`
  - core: `@audio-underview/logger@workspace:*`(아래 마스킹)
  - 넷 모두 devDependency `vitest@^5.0.5`(main과 같은 판. 프로토타입은 4)
- `tsconfig.json`과 `vitest.config.ts`는 그대로 옮긴다. tsconfig는 main `packages/logger`와 같은 독립형이고, 기본 lib(DOM)로 `fetch`, `FormData`, `atob`을 쓴다.

### seam(바꾸는 것)

- 이름과 import 경로: `@audio-underview/newscast-*-prototype` → `@audio-underview/newscast-*`
- 주석과 문서 머리말의 `prototype`을 main 이름으로 바꾼다. 옮긴 뒤 네 디렉터리에서 `grep -rni prototype`이 0건이어야 한다.
- **마스킹 블록:** core `sources/index.ts`의 provider 키 마스킹 블록을 지운다(`CREDENTIAL_BODY`, `SECRET_PATTERNS`, `PROVIDER_TEXT_MAXIMUM_LENGTH`, `redactSecrets`, `truncateText`, `redactAndTruncate`, 848~996행 근처). 그 자리에 `export { PROVIDER_TEXT_MAXIMUM_LENGTH, redactSecrets, truncateText, redactAndTruncate } from '@audio-underview/logger';`를 둔다.
  - logger의 `secret-redaction.ts`와 동작이 같다(규칙 11개, 순서, 정규식, 기본 길이 200, 표시 `… [truncated]`). 00 §4(d)가 정한 이동이다.
  - core의 마스킹 테스트는 그대로 두어, 다시 내보낸 함수가 같은 결과를 내는지 확인하는 데 쓴다.
- vitest 5에서 깨지는 테스트는 테스트 쪽 API 차이만 고친다. 패키지 소스는 마스킹 블록 말고 바꾸지 않는다.

### 그 밖

- `tools/package-graph/resources/graph.json`을 `pnpm --filter @audio-underview/package-graph generate`로 다시 만든다.
- `pnpm-lock.yaml`은 `pnpm add`와 `pnpm install`이 만든 결과를 쓴다.
- 패키지를 쓰는 워커는 아직 없다(2번에서 생긴다).

## 2. provider 키 route (crawler-manager-worker)

환경 변수 route(`handlers/environment-variables.ts`)와 같은 방식으로 만든다. 인증, CORS, 오류 형식 `{ error, error_description }`도 같다. 키 값은 응답, 로그, 오류 어디에도 나오지 않는다.

| method, path | user-vault 호출 | 응답 |
| -- | -- | -- |
| `GET /provider-keys` | `/internal/keys/status { userId }` | `200 { data: [{ provider, configured, last4, validated_at }] }`. 넷 모두 vault 순서(anthropic, openai, google, xai) |
| `GET /provider-keys/audit` | `/internal/keys/audit { userId, limit: 50 }` | `200 { data: [{ provider, action, at }] }`. 새것이 먼저. `action`은 `registered`·`replaced`·`removed`·`used` |
| `PUT /provider-keys/:provider` body `{ key }` | `/internal/keys/put { userId, provider, key, ip?, userAgent? }` | `200 { provider, configured: true, last4, validated_at }` |
| `DELETE /provider-keys/:provider` | `/internal/keys/delete { userId, provider, ip?, userAgent? }` | `200 { deleted: true }`. 지울 것이 없으면 `404 not_found` "Provider key not found" |

- `ip`는 `CF-Connecting-IP`, `userAgent`는 `User-Agent` 헤더다. 없으면 보내지 않는다. vault는 이 둘을 해시로만 감사 기록에 남긴다.
- `:provider`가 넷 중 하나가 아니면 `404 not_found` "Unknown provider"다. vault를 부르지 않는다.
- 다른 method는 `405 method_not_allowed`와 `Allow` 헤더다. 목록은 `GET`, 이력은 `GET`, provider 하나는 `PUT, DELETE`다.
- PUT 검사(vault와 같은 규칙):
  - 본문이 JSON이 아니면 `400 invalid_request` "Request body must be valid JSON"
  - `key`가 16~512자의 인쇄 가능한 ASCII(0x21~0x7E)가 아니면 `400 invalid_request` "Field 'key' must be 16 to 512 printable characters without spaces"
- vault 오류를 바꾸는 규칙:
  - put `400 invalid_key` → `400 invalid_key` "The provider did not accept this key"
  - put `503 validation_unavailable` → `503 validation_unavailable` "The provider could not be reached to check the key. Try again later"
  - 그 밖의 `400`(예: `unknown_provider`) → `500 server_error`. 여기서 먼저 검사했으니 vault가 거절하면 버그다.
  - `401`, `404`, `503 vault_unavailable`, `5xx`, 연결 실패 → `503 service_unavailable` "Provider keys are not available right now"
- `HELP.endpoints`에 네 route를 더한다.
- rate limit은 이번에 두지 않는다(사용량 제한 TES-248에서 본다). 프로토타입은 등록에 분당 5회 제한이 있었다.

### UserVaultClient

`sources/user-vault-client.ts`의 내부 호출을 경로를 받게 넓히고, 키 메서드를 더한다. 지금의 환경 변수 메서드와 오류 규칙(`UserVaultError(status, code)`, 연결 실패는 status 0, 응답 형식이 틀리면 `invalid_response`)은 그대로다.

```ts
getProviderKeyStatus(userID: string): Promise<ProviderKeyStatus[]>
listProviderKeyAudit(userID: string, limit: number): Promise<ProviderKeyAuditEvent[]>
putProviderKey(userID: string, provider: ProviderName, key: string, fingerprint: ClientFingerprint): Promise<ProviderKeyStatus>
deleteProviderKey(userID: string, provider: ProviderName, fingerprint: ClientFingerprint): Promise<boolean>

type ProviderName = 'anthropic' | 'openai' | 'google' | 'xai';
interface ProviderKeyStatus { provider: ProviderName; configured: boolean; last4: string | null; validatedAt: string | null }
interface ProviderKeyAuditEvent { provider: ProviderName; action: 'registered' | 'replaced' | 'removed' | 'used'; at: string }
interface ClientFingerprint { ip?: string; userAgent?: string }
```

vault 응답 형식(`workers/user-vault-worker/sources/index.ts`): status `{ keys: [...] }`, audit `{ events: [...] }`, put `{ provider, configured, last4, validatedAt }`, delete `{ removed }`.

### 테스트

- 환경 변수 route 테스트와 같은 구성으로 쓴다(`tests/` 아래, `SELF.fetch`, `runtime-harness.ts`).
- vault stand-in(`vitest.config.ts`의 `USER_VAULT_SCRIPT`)이 `/internal/keys/*`도 받게 한다. 지금 route 이름(`list`, `put` 등)으로 설정하는 환경 변수 테스트는 그대로 돌아야 한다.
- 꼭 있어야 하는 경우:
  - 넷의 성공
  - 모르는 provider와 잘못된 key는 vault를 부르지 않는다
  - vault 오류 바꾸기 규칙 전부
  - 응답과 로그(`console.*` spy)에 key 값이 없다
  - 401, 405
  - `ip`·`userAgent` 전달
  - 사용자끼리 섞이지 않는다
- `user-vault-client.test.ts`에 키 메서드의 경로, 본문, 토큰 헤더, 형식 검사를 더한다.

## 3. 웹 (applications/web)

`/settings`의 `EnvironmentVariablesSection` 아래에 provider 키 섹션을 더한다. 새 route나 메뉴는 없다. 문구는 지금 웹처럼 영어다.

- `components/settings/ProviderKeysSection.tsx`: provider마다 한 줄씩, 순서는 Anthropic, OpenAI, Google, xAI (Grok).
  - 상태: Configured / Not set, `•••• last4`, "Checked <날짜 시각>"(`validated_at`)
  - 등록·교체: password 입력(보이기·숨기기), Register / Replace 버튼. 보내면 입력을 바로 비운다.
  - 삭제: `DiscardDialog`로 확인한다.
  - 오류는 그 줄에 `role="alert"`로 보여 준다. 키 형식은 서버와 같은 규칙으로 먼저 검사한다.
  - 안내 문구:
    - 키는 암호화해 저장하고 다시 보여 주지 않는다.
    - provider 쪽에서 사용 한도를 정해 두라.
    - 뉴스캐스트 음성(TTS)은 늘 Google 키를 쓴다.
  - 불러오기, 오류와 다시 시도, 처음 상태를 다룬다.
- `components/settings/ProviderKeyAuditList.tsx`: 최근 이력(새것이 먼저). 동작은 Registered / Replaced / Removed / Used로 보여 준다. 키를 등록하거나 지우면 다시 불러온다.
- `hooks/use-provider-keys.ts`: `crawler-manager-request.ts`를 쓴다.
  - 목록: `useQuery` `['provider-keys']`
  - 이력: `useQuery` `['provider-key-audit']`
  - 등록: 환경 변수처럼 TanStack mutation을 쓰지 않는다. 키 값이 MutationCache에 남지 않게 하려는 것이다.
  - 삭제: `useMutation`. 끝나면 목록과 이력을 무효화한다.
- `schemas/provider-keys.ts`: 응답 zod schema와 키 형식 검사
- 테스트: `SettingsPage.test.tsx`처럼 MSW와 브라우저 모드로 쓴다. 목록, 등록(입력이 비워짐, 200), 서버 오류 문구(400 invalid_key, 503), 삭제 확인, 이력을 확인한다.

## 4. 확인

- 패키지 넷과 crawler-manager, web의 `typecheck`·`test`, 루트 `pnpm typecheck`
- staging(PR 배포)에서 세션 토큰으로 확인한다.
  - `GET /provider-keys`: 넷 모두 `configured: false`
  - 형식은 맞지만 틀린 키로 `PUT`: provider까지 다녀와 `400 invalid_key`
  - `GET /provider-keys/audit`: 이력 확인
- 실제 키 등록·교체·삭제는 사용자가 staging 웹에서 확인한다.

## 5. 추적 목록

| 항목 | 상태 | 원인 | 재접속 단계 |
| -- | -- | -- | -- |
| 뉴스캐스트 패키지 넷 | 미접속 | 쓰는 워커가 아직 없음 | 2(TES-265), 5(TES-268) |
| provider 키 사용 | 미접속 | 키를 쓰는 기능(proxy 호출)이 아직 없음 | 2(TES-265) |
| 키 등록 rate limit | 미접속 | 이번에 두지 않음 | 사용량 제한(TES-248) |
