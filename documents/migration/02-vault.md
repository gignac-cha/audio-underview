# 02 API 키 볼트 워커 · logger scrubber

## 1. 만들 것

| 대상 | 내용 |
| -- | -- |
| `packages/logger` | `sources/secret-redaction.ts`·`secret-redaction.test.ts` 신규, `logger.ts`에 scrub 추가, `index.ts`에 export 추가. 기존 export·시그니처는 바꾸지 않는다 |
| `workers/api-key-vault-worker` | 신규 워커. 사용자의 AI 모델 제공자(anthropic·openai·google·xai) API 키를 암호화해 보관하고, 그 키로 제공자를 대신 호출한다. service binding으로만 호출된다 |
| `.github/workflows/deploy-api-key-vault-worker.yml` | 신규 |
| `tools/deployment-planner/scripts/deployment-targets.ts` | 항목 1개 추가 |

logger와 볼트는 `newscast-*` 패키지를 import하지 않는다.

## 2. logger

### 2.1 `sources/secret-redaction.ts`

`CREDENTIAL_BODY = [A-Za-z0-9_*•-]`

아래 규칙을 **이 순서대로** 적용한다.

| 순서 | 정규식(플래그) | 치환 |
| -- | -- | -- |
| 1 | `Bearer\s+[A-Za-z0-9._~+/=*•-]{4,}` (`gi`) | `Bearer [REDACTED]` |
| 2 | `\bsk([-_])` + BODY`{4,}` (`g`) | `sk$1[REDACTED]` |
| 3 | `\bAIza` + BODY`{4,}` | `AIza[REDACTED]` |
| 4 | `\b([AI]Q)\.[A-Za-z0-9._*•-]{4,}` | `$1.[REDACTED]` |
| 5 | `\bxai-` + BODY`{4,}` | `xai-[REDACTED]` |
| 6 | `\bgsk_` + BODY`{4,}` | `gsk_[REDACTED]` |
| 7 | `\bya29\.[A-Za-z0-9._*•-]{4,}` | `ya29.[REDACTED]` |
| 8 | `\bgh[opusr]_` + BODY`{4,}` | `gh_[REDACTED]` |
| 9 | `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+` | `eyJ[REDACTED]` |
| 10 | `\borg-` + BODY`{4,}` | `org-[REDACTED]` |
| 11 | `\bproj_` + BODY`{4,}` | `proj_[REDACTED]` |

2~11은 플래그 `g`. export:

- `redactSecrets(text: string): string` — 위 표를 순서대로 적용.
- `PROVIDER_TEXT_MAXIMUM_LENGTH = 200`
- `truncateText(text, maximumLength = PROVIDER_TEXT_MAXIMUM_LENGTH)` — 길이 이하면 그대로, 넘으면 앞 `maximumLength`자 + `… [truncated]`.
- `redactAndTruncate(text, maximumLength = PROVIDER_TEXT_MAXIMUM_LENGTH)` — `truncateText(redactSecrets(text), maximumLength)`.

입출력(테스트에 그대로 쓴다):

| 입력 | 출력 |
| -- | -- |
| `key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789xyz` | `key=sk-[REDACTED]` |
| `sk-ant-api03-AAaaBBbbCCcc-99` | `sk-[REDACTED]` |
| `sk_live_51H8xYzAbCdEfGhIj` | `sk_[REDACTED]` |
| `AIzaSyD-1234567890abcdefgHIJKLmnop` | `AIza[REDACTED]` |
| `API key not valid: AQ.Ab8RN6-a_b.c1234 for this project` | `API key not valid: AQ.[REDACTED] for this project` |
| `see the FAQ.Section2 for details` | 그대로 |
| `xai-abcdef1234567890ABCDEF` | `xai-[REDACTED]` |
| `gsk_aBcD1234EfGh5678IjKl` | `gsk_[REDACTED]` |
| `sk-***abcd`, `sk-••••••••abcd` | `sk-[REDACTED]` |
| `You have insufficient quota in org-9dF2kQwErTyUiOpA (proj_aBcD1234).` | `You have insufficient quota in org-[REDACTED] (proj_[REDACTED]).` |
| `ya29.a0AfB_byC1234567890-_abcdef` | `ya29.[REDACTED]` |
| `ghp_16C7e42F292c6912E7710c838347Ae178B4a` (gho_·ghu_·ghs_·ghr_ 동일) | `gh_[REDACTED]` |
| `rejected token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMTExMTExMS0xMTExLTUxMTEifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` | `rejected token eyJ[REDACTED]` |
| `bearer eyJhbGciOiJIUzI1NiJ9.payload.signature` | `Bearer [REDACTED]` |
| `invalid_api_key (401)`, `stop_reason=max_tokens`, `after the reorg-chart landed` | 그대로 |
| `task-force scheduling`, `risk-score too high`, `disk-usage exceeded`, `desk_assignment pending` | 그대로 |

### 2.2 `sources/logger.ts` — scrub

로그 항목을 출력 직전 한 곳에서 scrub하고, JSON 출력과 pretty 출력 모두 scrub된 항목을 쓴다. 값을 재귀로 훑는다.

- 문자열 → `redactSecrets`
- `null`·원시값 → 그대로
- 깊이 8 이상 → `'[Truncated]'`
- 현재 재귀 경로(조상)에 이미 있는 객체 → `'[Circular]'`. 순환이 아닌 공유 참조는 나오는 곳마다 펼친다.
- `Error` → `{ name, message: redactSecrets(message), stack: 문자열이면 redactSecrets(stack) 아니면 undefined, cause: 있으면 재귀 scrub 아니면 undefined }`. 그 밖의 own enumerable 속성(예: `code`·`status`)도 재귀 scrub해 함께 남기고, 이름이 겹치면 앞의 네 필드가 우선한다.
- `Date` → 그대로
- `toJSON`이 함수인 객체(예: `URL`) → `toJSON()` 결과를 재귀 scrub
- 배열 → 원소마다 재귀
- 객체 → 값마다 재귀

### 2.3 `sources/index.ts` — 추가할 export

```ts
export {
  PROVIDER_TEXT_MAXIMUM_LENGTH,
  redactSecrets,
  truncateText,
  redactAndTruncate,
} from './secret-redaction.ts';
```

### 2.4 테스트

- `secret-redaction.test.ts`:
  - §2.1 입출력 표 전부
  - `truncateText`: 이하면 그대로, 넘으면 표식, 기본값 200
  - `redactAndTruncate`: 자른 자리에 키 앞부분이 남지 않음, 긴 본문을 가린 뒤 자름
- `logger.test.ts`에 추가:
  - message·context·data가 scrub된다.
  - JWT가 로그 항목에서 사라진다.
  - `error.message`는 가려지고 status·request id는 남는다.
  - `error.cause`가 `{}`가 아니라 펼쳐져서 scrub된다.
  - 요청·응답 본문이 pretty 출력에서도 scrub된다.
  - 순환 참조가 있어도 예외 없이 기록된다.
  - 순환이 아닌 공유 참조는 `[Circular]`가 되지 않는다.
  - `URL`은 href 문자열로, `Error`의 `code`·`status`는 그대로 남는다.
  - 접두사를 포함한 일반 단어는 그대로다.

## 3. `workers/api-key-vault-worker`

### 3.1 패키지·설정

- `package.json`: `pnpm init` 후 `name: "@audio-underview/api-key-vault-worker"`, `private: true`, `type: "module"`, `main: "./sources/index.ts"`, scripts `dev: wrangler dev`·`deploy: wrangler deploy`·`test: vitest run`·`typecheck: tsc --noEmit`. 의존성은 `pnpm add @audio-underview/logger@workspace:*`. devDependencies는 `workers/crawler-manager-worker`와 같은 `catalog:worker` 항목을 `pnpm add -D <이름>@catalog:worker`로 추가한다.
- `tsconfig.json`: `workers/crawler-manager-worker`와 같은 형태.
- `wrangler.toml`:
  ```toml
  name = "audio-underview-api-key-vault-worker"
  main = "sources/index.ts"
  compatibility_date = "<다른 메인 워커와 같은 값>"
  workers_dev = false

  [[d1_databases]]
  binding = "DB"
  database_name = "audio-underview-api-keys"
  database_id = "00000000-0000-0000-0000-000000000000"

  [vars]
  PROVIDER_KEY_KEK_VERSION = "1"

  [observability.logs]
  enabled = true
  head_sampling_rate = 1
  ```
  `[[routes]]`는 두지 않는다. §3.2의 secret은 이름과 용도만 주석으로 적는다.

### 3.2 환경

| 이름 | 종류 | 내용 |
| -- | -- | -- |
| `DB` | D1 | §3.5 테이블 |
| `PROVIDER_KEY_KEK` | secret, 필수 | 키 암호화 키(KEK) |
| `PROVIDER_KEY_KEK_PREVIOUS` | secret, 선택 | 이전 KEK |
| `PROVIDER_KEY_KEK_VERSION` | var | 새로 쓰는 행의 세대 번호. 양의 정수로 못 읽으면 1 |
| `VAULT_INTERNAL_TOKEN` | secret, 선택 | 호출자가 헤더로 보내야 하는 값 |
| `AI_GATEWAY_BASE_URL` | secret, 선택 | 앞뒤 공백 제거 후 비어 있지 않으면 게이트웨이 경유. `https:` URL만 받는다 |
| `AI_GATEWAY_TOKEN` | secret, 선택 | 있으면 `cf-aig-authorization: Bearer <값>` |
| `AUDIT_HASH_SALT` | secret, 선택 | 감사 로그 해시 salt |

KEK 목록: `[PROVIDER_KEY_KEK]`, `PROVIDER_KEY_KEK_PREVIOUS`가 있고 현재와 다르면 뒤에 추가. 암호화는 첫 번째로, 복호화는 앞에서부터 차례로 시도한다.

### 3.3 요청 처리 순서

1. `POST`가 아니면 404 `{ error: 'not_found' }`.
2. `VAULT_INTERNAL_TOKEN`이 설정돼 있으면 `x-provider-key-vault-token` 헤더를 상수 시간으로 비교한다. 없거나 다르면 401 `{ error: 'unauthorized' }`.
3. 경로가 §3.7의 6개가 아니면 404 `{ error: 'not_found' }`.
4. 본문이 JSON 객체가 아니면 400 `{ error: 'invalid_request' }`.
5. `userId`가 1~200자 문자열이 아니면 400 `{ error: 'invalid_request' }`.
6. `PROVIDER_KEY_KEK`가 없거나 비었으면 503 `{ error: 'vault_unavailable' }`.
7. 라우트 처리.

### 3.4 봉투 암호화

- KEK: `SHA-256(UTF-8(secret))` 32바이트를 raw AES-GCM 키로 import.
- DEK: 저장할 때마다 새 난수 32바이트.
- 사용자 키를 DEK로 AES-GCM 암호화하고, DEK를 KEK로 AES-GCM 암호화(wrap)한다.
- IV: 12바이트 난수, 암호화할 때마다 새로. 키 암호화와 DEK wrap은 각자 다른 IV를 쓴다.
- AAD(두 단계 공통): `userId`, `provider`, `String(keyVersion)`, `createdAt` 네 값을 각각 `<UTF-8 바이트 길이>:<값>`으로 만들어 `|`로 잇고 UTF-8로 인코딩한다.
- 저장: `ciphertext`·`iv`·`wrapped_dek`·`dek_iv` 모두 base64.
- 복호화: 행 값으로 AAD를 다시 만들고, KEK 목록을 차례로 시도해 DEK를 푼 뒤 키를 푼다. 어느 KEK로도 풀리지 않거나 base64가 깨졌으면 예외 없이 `null`.
- rewrap: DEK를 푼 뒤 현재 KEK와 새 IV로 다시 wrap해 `wrapped_dek`·`dek_iv`만 바꾼다. 사용자 키는 복호화하지 않고 `ciphertext`·`iv`·`key_version`·`created_at`은 그대로 둔다. 풀리지 않으면 `null`.
- `keyVersion`·`createdAt`은 행을 쓴 뒤 바꾸지 않는다.
- `last4`: 평문 키의 마지막 4글자.

### 3.5 `schema.sql`과 D1 접근

```sql
CREATE TABLE IF NOT EXISTS provider_keys (
  user_id      TEXT    NOT NULL,
  provider     TEXT    NOT NULL,
  ciphertext   TEXT    NOT NULL,
  iv           TEXT    NOT NULL,
  wrapped_dek  TEXT    NOT NULL,
  dek_iv       TEXT    NOT NULL,
  key_version  INTEGER NOT NULL DEFAULT 1,
  last4        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  validated_at TEXT,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS key_audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  action   TEXT NOT NULL,
  at       TEXT NOT NULL,
  ip_hash  TEXT,
  ua_hash  TEXT
);

CREATE INDEX IF NOT EXISTS key_audit_log_user_id_id
  ON key_audit_log (user_id, id DESC);
```

- TypeScript 식별자는 풀어 쓴다: `initializationVector`, `wrappedDataEncryptionKey`, `dataEncryptionKeyInitializationVector`.
- `created_at`·`validated_at`·`at`은 워커가 ISO 8601로 쓴다.
- D1 접근은 한 모듈에만 둔다. 그 모듈은 `userId`로 범위가 묶인 저장소 객체만 내주고, 모든 문장에 `user_id = ?`가 있다. 컬럼은 명시한다(`SELECT *` 금지).
- 키 저장: `INSERT … ON CONFLICT (user_id, provider) DO UPDATE SET`으로 봉투 컬럼 전부를 바꾼다.
- 알 수 없는 provider 값의 행은 무시한다.
- `key_audit_log`에는 `INSERT`와 `SELECT`만 있다. `UPDATE`·`DELETE`는 없다.
- 감사 읽기: `SELECT provider, action, at FROM key_audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?`. `limit`은 내림한 뒤 1~200으로 자른다. `action`이 §3.8의 네 값이 아닌 행은 건너뛴다.

### 3.6 제공자

| provider | 직접 origin | 게이트웨이 segment | 게이트웨이 뒤 경로 | 인증 헤더 | 키 검증 호출 |
| -- | -- | -- | -- | -- | -- |
| `anthropic` | `https://api.anthropic.com` | `anthropic` | path 그대로 | `x-api-key: <키>`, `anthropic-version: 2023-06-01` | `POST v1/messages/count_tokens`, `content-type: application/json`, 본문 `{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}` |
| `openai` | `https://api.openai.com` | `openai` | 앞의 `v1/` 하나를 뗀다 | `authorization: Bearer <키>` | `GET v1/models` |
| `google` | `https://generativelanguage.googleapis.com` | `google-ai-studio` | path 그대로 | `x-goog-api-key: <키>` | `GET v1beta/models?pageSize=1` |
| `xai` | `https://api.x.ai` | `grok` | path 그대로 | `authorization: Bearer <키>` | `GET v1/models` |

provider 순서는 `anthropic, openai, google, xai`로 고정한다. 키는 URL에 넣지 않는다.

**URL 만들기** (호출자는 path만 준다)
- `invalid_path`로 거부하는 경우:
  - path가 비었다.
  - `^[A-Za-z][A-Za-z0-9+.-]*:`에 맞는다.
  - `//`로 시작한다.
  - `\`를 포함한다.
  - 상위로 올라간다. 판정은 이렇다. `\t\n\r`을 지우고 `?`·`#` 앞부분만 본다. `%2f`·`%5c`(대소문자 무관)가 있으면 거부한다. `/`로 나눈 조각 중 `%2e`(대소문자 무관)를 `.`로 바꿨을 때 `..`인 조각이 있으면 거부한다. `%252e`는 풀지 않는다.
- 선행 `/`를 떼고 잇는다. 직접 호출은 `<origin>/<path>`, 게이트웨이는 `<base 끝 / 제거>/<segment>/<뒤 경로>`.
- base 파싱 실패나 base가 `https:`가 아니면 `blocked_origin`, 완성 URL 파싱 실패는 `invalid_path`.
- 완성 URL의 origin이 base origin과 다르면 `blocked_origin`.
- 완성 URL의 pathname이 허용 접두사로 시작하지 않으면 `invalid_path`. 직접 호출은 `/`, 게이트웨이는 `<base pathname>/<segment>/`.
- 거부 예(모든 provider, 게이트웨이 경유 포함):
  - `https://evil.example.com/v1/models`, `http://169.254.169.254/latest/meta-data/`, `//evil.example.com/v1/models`, `file:///etc/passwd`
  - `v1/../../evil`, `..`, `v1\evil.example.com`, 빈 문자열
  - `v1/%2e%2e/%2e%2e/evil`, `v1/%2E%2E/%2E%2E/evil`, `v1/.%2e/.%2e/evil`, `v1/%2e./%2e./evil`, `%2e%2e`
  - `v1/.<TAB>./evil`, `v1/.<LF>./evil`, `v1/.<CR>./evil`
  - `v1/..%2fevil`, `v1/%2e%2e%2fevil`, `v1/..%5cevil`
  - 게이트웨이: `v1/%2e%2e/%2e%2e/%2e%2e/%2e%2e/attacker-account/attacker-gateway/openai/v1/chat/completions`
  - 게이트웨이: `v1/%2e%2e/evil`(모든 provider)
- 허용 예:
  - `v1/models/evil.example.com`은 origin이 그대로다.
  - 쿼리는 유지된다.
  - 선행 `/`는 허용한다.
  - 게이트웨이 `v1/%252e%252e/models`는 `<base>/openai/%252e%252e/models`가 된다.

**헤더**: 호출자 헤더는 이름을 소문자로 바꾼 뒤 `content-type`·`accept`·`anthropic-version`·`anthropic-beta`의 문자열 값만 남긴다. 그 위에 인증 헤더, 그다음 게이트웨이 토큰 헤더 순으로 덮어쓴다.

**키 검증**
- 모양: 16~512자, 모든 글자가 0x21~0x7E. 아니면 제공자를 호출하지 않는다.
- 검증 호출: 게이트웨이가 설정돼 있으면 경유, 10초 타임아웃, 응답 본문은 읽고 버린다. redirect는 따라가지 않는다(`redirect: 'manual'`).
- 결과: 2xx는 `valid`, 400·401·403은 `invalid`, 그 밖의 상태(3xx 포함)·네트워크 실패·타임아웃은 `unavailable`.

### 3.7 라우트 (전부 `POST`, JSON 본문)

본문의 선택 필드 `ip`·`userAgent`는 §3.8 감사용이다.

**`/internal/keys/put`** `{ userId, provider, key }`
1. provider가 넷 중 하나가 아니면 400 `{ error: 'unknown_provider' }`.
2. 키 모양이 틀리면 400 `{ error: 'invalid_key' }`.
3. 검증이 `invalid`면 400 `{ error: 'invalid_key' }`, `unavailable`이면 503 `{ error: 'validation_unavailable' }`. 저장하지 않는다.
4. 기존 행이 있는지 쓰기 전에 읽는다.
5. `now = new Date().toISOString()`. 봉투를 `(userId, provider, 현재 세대, now)`로 새로 만들어 저장한다. `validated_at = now`.
6. 감사: 기존 행이 없었으면 `registered`, 있었으면 `replaced`.
7. 200 `{ provider, configured: true, last4, validatedAt: now }`.

**`/internal/keys/delete`** `{ userId, provider }`
- provider 검사 실패는 400 `unknown_provider`. 삭제 후 200 `{ removed }`. 실제로 지웠을 때만 감사 `removed`.

**`/internal/keys/status`** `{ userId }`
- 200 `{ keys: [{ provider, configured, last4, validatedAt }] }`. 항상 네 개, 고정 순서. 행이 없으면 `configured: false, last4: null, validatedAt: null`.

**`/internal/keys/audit`** `{ userId, limit? }`
- `limit`이 숫자면 그 값, 아니면 50. 200 `{ events: [{ provider, action, at }] }` 최신순. 읽기 실패 시 200 `{ events: [] }`.

**`/internal/keys/rewrap`** `{ userId }`
- 그 사용자의 모든 행을 rewrap한다. 풀리지 않는 행은 건드리지 않고 센다. 200 `{ rewrapped, unrecoverable }`.

**`/internal/proxy`** `{ userId, provider, path, method?, headers?, body? | bodyBase64? }`
1. provider 검사 실패는 400 `{ ok: false, error: 'unknown_provider' }`.
2. `path`가 문자열이 아니면 400 `{ ok: false, error: 'invalid_path' }`.
3. `method`는 대문자로 바꾸고 기본값은 `POST`다. `GET·POST·PUT·PATCH·DELETE`가 아니면 400 `{ ok: false, error: 'invalid_request' }`.
4. `body`가 있는데 문자열이 아니면 `invalid_request`. `method`가 `GET`인데 `body`나 `bodyBase64`가 있어도 `invalid_request`.
5. `bodyBase64`는 다음 경우 모두 `invalid_request`다. 문자열이 아닌 경우, `body`와 함께 온 경우, 16,000,000자를 넘는 경우, base64로 풀리지 않는 경우.
6. URL 만들기 실패는 400 `{ ok: false, error: 'invalid_path' | 'blocked_origin' }`. 키를 읽기 전에 거른다.
7. 행이 없거나 복호화 결과가 `null`이면 404 `{ ok: false, error: 'no_key' }`.
8. 감사 `used`를 제공자 호출 전에 기록한다.
9. §3.6 헤더와 본문으로 fetch한다. 바이너리면 풀린 바이트를 그대로 보낸다. 타임아웃은 240초. redirect는 따라가지 않고(`redirect: 'manual'`), 3xx도 11번처럼 데이터로 전달한다.
10. fetch 예외는 502 `{ ok: false, error: 'provider_unreachable' }`.
11. 200 `{ ok: true, provider, status, contentType, body }`. 제공자 상태 코드와 본문 텍스트를 그대로 싣는다. 단, `contentType`·`body`에 평문 키가 있으면 `[REDACTED]`로 바꾼다(§3.9). `contentType`이 없으면 `application/octet-stream`.

### 3.8 감사 로그

- 동작: `registered`·`replaced`·`removed`·`used`.
- `ip`·`userAgent`는 비어 있지 않은 문자열일 때만 쓴다. 각각 `SHA-256(<salt>\n<value>)` 16진수로 저장한다. salt가 없으면 빈 문자열이다. 값이 없으면 `NULL`이다.
- 감사 쓰기 실패는 에러 로그만 남기고 키 작업은 계속한다.

### 3.9 로그

- `createWorkerLogger({ defaultContext: { module: 'api-key-vault-worker' } })`.
- 평문 키·DEK·KEK·검증 응답 본문은 로그·응답·오류 메시지에 넣지 않는다. 키 조각은 `last4`만.
- 외부에서 온 오류 문자열은 `redactAndTruncate`를 거쳐 기록한다.
- 로그를 남기는 곳:
  - KEK 없음: error
  - 키 거부: warn
  - 검증 불가: warn
  - 저장: info, provider와 last4만
  - 삭제: info
  - rewrap: info, 건수
  - URL 거부: warn
  - 복호화 실패: error, provider와 keyVersion만
  - fetch 실패: error
  - 감사 쓰기·읽기 실패: error

### 3.10 파일 구성

`sources/index.ts`(라우터), `environment.ts`(환경·KEK 목록·게이트웨이), `envelope.ts`(§3.4), `storage.ts`(§3.5), `providers.ts`(§3.6 표·URL·헤더), `validation.ts`(§3.6 검증), `audit.ts`(§3.8), 모듈마다 `*.test.ts`. vitest로 돌리고 D1은 테스트 안의 가짜 객체로, `fetch`는 stub으로 대신한다.

### 3.11 테스트

**envelope**
- AAD가 `<바이트 길이>:<값>`으로 이어진다. 다바이트 글자도 바이트로 센다.
- `userId='x|google|1|T', createdAt='T'`와 `userId='x', createdAt='T|google|1|T'`의 AAD가 다르다.
- 왕복하면 원래 키가 나온다. 저장 필드에 평문 키가 없다.
- 다른 봉투의 wrapped DEK는 풀리지 않는다.
- 같은 평문을 암호화할 때마다 IV가 다르다.
- 다음 경우는 모두 `null`이다. 다른 사용자로 옮긴 행, 다른 provider로 바꾼 행, 구분자로 경계를 속여 옮긴 행, `key_version`이나 `created_at`을 고친 행.
- 이전 KEK가 목록에 있으면 옛 행이 풀린다.
- rewrap 뒤에는 새 KEK만으로 풀린다.
- 풀 수 없는 행은 `null`이다. 다른 사용자로 옮긴 행은 rewrap하지 않는다.
- `last4`는 네 글자다.
- 깨진 base64는 `null`이다.

**providers**
- provider는 네 개만 받는다.
- 인증 헤더가 표와 같고, 키가 쿼리에 없다.
- 직접 URL이 각 origin에 고정된다. 쿼리를 유지하고 선행 `/`를 허용한다.
- §3.6 거부 예 전부가 직접 호출과 게이트웨이 경유 모두에서 거부된다.
- §3.6 허용 예 전부가 통과한다.
- 게이트웨이 segment가 표와 같고, openai만 `v1/`을 뗀다. base 끝의 `/`를 허용한다.
- `cf-aig-authorization`은 토큰이 있을 때만 붙는다.
- 호출자 헤더는 허용 목록만 넘어간다. headers가 없거나 객체가 아니어도 동작한다.

**validation**
- 모양 검사:
  - 통과: `AIzaSyD-1234567890abcdefgHIJKLmnop`, `AQ.Ab8RN6L1234567890abcdefg`, `xai-abcdef1234567890ABCDEF`, `sk-proj_underscores-and-dashes-1234`
  - 거부: 빈 값, `short`, 앞뒤 공백, 끝 개행, curl 명령 통째, 513자, 숫자
- 검증 호출이 provider별 헤더로 나가고, 키가 URL에 없다.
- 400·401·403은 `invalid`다. 404·429·500·502·503과 네트워크 실패는 `unavailable`이다.
- 게이트웨이가 설정돼 있으면 경유한다. `http://` 게이트웨이로는 호출하지 않는다.
- redirect를 따라가지 않고, 3xx는 `unavailable`이다.

**audit**
- 동작은 네 개만 받는다.
- 본문에서 `ip`·`userAgent`만 꺼낸다. 비었거나 문자열이 아니면 버린다.
- 해시는 같은 salt면 같고 salt가 다르면 다르다. 두 필드가 섞이지 않는다.
- 값이 없으면 `NULL`이다. 해시에 원래 값이 없다.

**index**
- GET은 404, 모르는 경로는 404, `userId` 없음은 400이다.
- KEK가 없으면 503이고 저장하지 않는다.
- 내부 토큰은 설정이 없으면 필요 없고, 설정되면 헤더와 값 일치가 필요하다.
- put:
  - 저장된 행에 평문이 없다.
  - 모르는 provider, `invalid`, `unavailable`이면 저장하지 않는다.
  - 모양이 틀린 키는 제공자를 호출하지 않는다.
  - 교체하면 봉투 전체가 새로 만들어진다.
  - 사용자 간 행이 섞이지 않는다.
- status는 항상 네 개이고 `last4`만 나온다. 행이 없는 사용자도 네 개다.
- delete는 지정한 사용자·provider만 지운다. 없던 키는 `removed: false`다.
- proxy:
  - 볼트가 복호화해 인증 헤더를 붙인다.
  - 제공자가 키를 되돌려 보내도 응답에 키가 없다.
  - 호출자 인증 헤더는 무시한다.
  - 미등록·다른 사용자·옮겨진 행은 `no_key`다.
  - URL 검사가 키 읽기보다 먼저다. 호출자가 고른 게이트웨이 namespace로는 나가지 않는다.
  - 허용 안 된 메서드는 400이다. GET에 본문이 붙어도 400이고 제공자를 호출하지 않는다. 연결 실패는 502이고 요청 내용을 인용하지 않는다. 제공자 오류는 데이터로 전달한다.
  - 바이너리 본문은 바이트 그대로 content-type boundary를 유지한다. 텍스트와 바이너리를 같이 보내거나 base64가 아니거나 상한을 넘으면 400이다.
  - 게이트웨이는 볼트 설정만 쓴다. `http://` 게이트웨이는 400 `blocked_origin`이고 제공자를 호출하지 않는다.
  - redirect를 따라가지 않고 3xx를 데이터로 전달한다.
- rewrap은 복호화 없이 새 KEK로 옮기고, 못 여는 행은 센다.
- 어떤 응답에도 평문 키가 없다.
- 감사 로그:
  - 첫 등록은 `registered`, 두 번째는 `replaced`다.
  - 실제로 지웠을 때만 `removed`다.
  - 키를 꺼내 쓰면 `used`이고, 키에 닿지 못한 요청은 기록되지 않는다.
  - 지문은 salt 해시로만 저장되고, 없으면 `NULL`이다.
  - 최신순이고 해시가 나오지 않는다. 다른 사용자 이벤트가 안 보인다. `limit`을 지킨다.
  - 이벤트를 수정·삭제하는 라우트가 없다.
  - 감사 테이블이 망가져도 키 작업은 성공한다.

## 4. 배포 wiring

- `.github/workflows/deploy-api-key-vault-worker.yml`: `deploy-scheduler-worker.yml`과 같은 형태로 만든다.
  - `name: "Deploy: API Key Vault Worker"`, job 이름 `Deploy API Key Vault Worker`
  - `on: workflow_dispatch:`, 입력 없음
  - `workingDirectory: workers/api-key-vault-worker`, `command: deploy`
  - `apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}`, `accountId: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}`
  - `secrets:`·`env:`는 넣지 않는다.
  - 최상위 `permissions: contents: read`, checkout 단계에 `persist-credentials: false`.
- `deployment-targets.ts`: `DEPLOYMENT_TARGETS`에 `['@audio-underview/api-key-vault-worker', { workflow: 'deploy-api-key-vault-worker.yml', paused: AWAITING_SECRETS }]`를 추가한다.
- 확인: `pnpm --filter @audio-underview/deployment-planner test`.
