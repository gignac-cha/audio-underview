# 크롤러 실행 환경 확장 설계

작성일 2026-10-13. 이 설계대로 `feature/crawler-runtime` 브랜치에 구현한다. 요구사항은 `documents/migration/07-crawler-runtime.md`(Linear TES-247)에 있다.

지금 크롤러 코드는 AWS Lambda(`functions/crawler-code-runner-function`) 안의 `node:vm`에서 실행된다. 실행은 5초, 코드는 1만 자까지이고, 코드 안에서 `fetch`와 `console`을 쓸 수 없다. 이 문서는 크롤러 코드가 외부 API를 부르고, 파일을 남기고, 사용자의 환경 변수를 읽고, 로그를 남길 수 있게 하는 방법을 정한다.

기준 코드는 `main`(`ed8296d`)이다. 고치는 곳은 아래 다섯 곳이다. 새 npm 의존성은 없다. Lambda와 웹은 바꾸지 않는다.

- `packages/supabase-connector`
- `workers/tools`
- `workers/crawler-manager-worker`
- `workers/scheduler-manager-worker`
- `workers/user-vault-worker`

## 1. 전체 흐름

1. 크롤러 코드 실행은 crawler-manager-worker가 Cloudflare Dynamic Worker로 한다. Lambda는 web 크롤러의 페이지 가져오기에만 남는다.
2. crawler-manager는 실행 한 번마다 아래 순서로 처리한다.
   1. 크롤러를 읽고, 실행하는 사용자가 크롤러 작성자인지 본다.
   2. 작성자면 vault에서 그 사용자의 환경 변수 값을 받는다.
   3. web 크롤러면 지금처럼 Lambda가 URL을 가져와 본문을 돌려준다. 이 본문이 입력이 된다. 출발 IP, 헤더, 사설망 차단이 지금과 같다.
   4. Dynamic Worker에 코드를 올려 실행한다.
   5. 결과와 로그에서 환경 변수 값을 가린다.
3. 크롤러 코드는 지금처럼 함수 하나다. 두 번째 인자 `context`가 새로 생기고, 여기에 환경 변수(`context.environment`)와 파일(`context.files`)이 있다. 전역 `fetch`와 `console`이 동작한다.
4. 파일은 R2 버킷에 두고, 메타데이터는 Supabase `crawler_files`에 둔다.
5. 스케줄러는 단계마다 `runCrawler(crawlerID, input, { userUUID, runID })`를 부르고, 결과와 로그를 단계 실행 기록에 남긴다.
6. 직접 실행은 `POST /crawlers/:id/runs`다. 실행 기록을 `crawler_runs`에 남기고, 응답에 결과와 로그가 함께 온다.
7. 환경 변수는 crawler-manager의 `/environment-variables` API로 관리한다. 값은 user-vault-worker의 D1에 암호화해 둔다.
8. crawler-manager의 cron이 기한이 지난 파일과 지워진 회차의 파일을 R2에서 지운다.

## 2. 결정한 것과 이유

### 실행 위치

**실행은 Lambda가 아니라 Dynamic Worker에서 한다.** `node:vm`은 보안 경계가 아니다. 지금 sandbox에는 호스트의 `Object`·`Function`이 그대로 들어가 있어서, `Object.constructor('return process')()` 한 줄이면 Lambda 프로세스에 닿는다. Lambda는 실행 환경을 여러 호출에 재사용하므로, 한 사용자의 코드가 전역을 바꿔 두면 다음 호출에 들어오는 다른 사용자의 입력과 환경 변수를 읽을 수 있다. 환경 변수를 넘기는 순간 이 문제는 다른 사용자의 비밀이 새는 문제가 된다. Dynamic Worker는 실행마다 V8 isolate에서 돈다. 외부 요청은 우리가 지정한 gateway로만 나가고(`globalOutbound`), 크롤러 코드가 받는 것은 우리가 넘긴 값과 RPC stub뿐이다.

**실행기는 crawler-manager-worker 안에 둔다.** 크롤러 조회, 인증, 스케줄러가 부르는 RPC가 이미 여기 있다. 따로 워커를 두면 호출이 한 번 늘 뿐 얻는 것이 없다. 배포된 적 없는 `crawler-code-runner-worker`와 Lambda는 건드리지 않는다. Lambda는 web 크롤러의 페이지 가져오기와 웹 편집기의 시험 실행에 계속 쓰인다.

**web 크롤러의 페이지 가져오기는 Lambda에 남긴다.** Cloudflare에서 가져오면 출발 IP가 바뀌고 `CF-Worker` 헤더가 붙는다. 프로토타입의 crawler-manager(Cloudflare)는 GeekNews에서 403을 받은 적이 있다. 요구사항은 web 크롤러의 지금 동작과 시스템 크롤러 5개를 그대로 두라고 한다.
- crawler-manager는 지금의 `HTTPCodeRunnerClient`로 Lambda의 `/run`을 부른다. `type: 'web'`과 본문을 그대로 돌려주는 코드 `(body) => body`를 보낸다.
- Lambda 코드와 배포는 바꾸지 않는다. 요청 헤더(`WEB_REQUEST_HEADERS`), 사설망 차단, 10초 제한, 5xx 재시도가 지금과 같다.
- 가져온 본문으로 크롤러 코드를 Dynamic Worker에서 실행한다.
- 차이 하나: Lambda 응답 한도(6 MB) 때문에 본문이 6 MB를 넘는 페이지는 실패한다. 지금은 코드가 줄인 결과만 돌려주므로 성공할 수 있었다.

**크롤러 코드는 CommonJS 모듈로 올린다.** ES 모듈은 언제나 strict mode라서, 지금 `node:vm`(sloppy mode)에서 돌던 코드 중 일부가 깨진다. 예를 들면 선언 없는 대입, 8진수 리터럴, `arguments.callee`, `with`다. `{ cjs: 'module.exports = (\n' + code + '\n);' }` 모듈은 sloppy mode를 유지한다(13절에서 로컬 확인). 다만 Workers는 문자열에서 코드를 만들지 못하므로 `eval`과 `new Function`은 Lambda와 달리 `EvalError`를 던진다(12절).

### isolate와 값 전달

**isolate는 사용자, 코드, 설정 단위로 나눈다.** `LOADER.get(id)`의 ID는 아래 형식이다. 사용자가 다르면 같은 코드라도 isolate를 같이 쓰지 않는다. 그래서 한 사용자의 환경 변수 값이 다른 사용자의 실행이 도는 isolate에 남는 일이 없다. 같은 사용자가 같은 코드를 다시 실행하면 따뜻한 isolate를 다시 쓸 수 있다. 설정을 해시에 넣는 이유는 `get()`이 같은 ID에 같은 코드와 설정을 요구하기 때문이다.

```
crawler:<실행 사용자 UUID 또는 none>:<SHA-256 hex>
SHA-256 입력 = JSON.stringify({ compatibilityDate, compatibilityFlags, limits }) + "\0" + runner 모듈 + "\0" + 크롤러 코드
```

**실행마다 다른 값은 호출 인자로 넘긴다.** 환경 변수 값은 바뀔 수 있고 파일 저장 권한은 실행마다 다르므로 `WorkerCode.env`에 넣지 않는다. runner의 `run(input, capabilities)` 인자로 넘긴다. 파일 저장소는 `RpcTarget` 객체로 넘긴다. RPC로는 prototype의 메서드만 보이고 인스턴스 필드는 보이지 않는다(13절에서 로컬 확인). 그래도 필드는 `#private`으로 둔다.

**실행이 끝나면 파일 저장소를 닫는다.** 호스트가 결과를 정하면(시간 초과 포함) `CrawlerFileCapability.close()`를 부른다. 그 뒤의 `save`와 `read`는 `Files are not available in this run`을 던진다. 호스트가 시간 초과로 끊어도 isolate의 코드는 계속 돌 수 있어서, 이렇게 해야 실패로 기록된 실행이 파일을 늘리지 않는다. 외부 요청은 막을 수 없다(12절).

### 로그와 시간

**로그는 isolate 안에서 모은다.** runner 모듈이 `console`의 메서드를 바꿔 실행마다 버퍼에 쌓는다. 같은 isolate에서 두 실행이 동시에 돌 수 있으므로 버퍼는 `AsyncLocalStorage`로 실행별로 나눈다(`nodejs_als` flag). Tail Worker는 응답을 보낸 뒤에야 로그가 도착하므로 직접 실행 응답에 로그를 실을 수 없어 쓰지 않는다.

**로그 한도는 크기와 개수 둘 다다.** 항목마다 `메시지 글자 수 + 64`를 비용으로 세어 합계 65,536까지, 항목 수는 1,000개까지 남긴다. 빈 메시지를 끝없이 찍어도 버퍼와 저장 크기가 커지지 않게 하기 위해서다. 메시지 안의 NUL(`\u0000`)은 `�`로 바꾼다. Postgres JSONB가 NUL을 받지 않기 때문이다.

**시간은 runner가 먼저 끊는다.** 벽시계 5분이 지나면 runner가 그때까지의 로그와 함께 시간 초과로 끝낸다. CPU는 `limits.cpuMs`로 30초까지다. CPU를 다 쓰는 무한 루프는 runner의 타이머가 돌지 못하므로 CPU 한도가 끊는다. 지금 Lambda에서 동기 무한 루프는 시간 초과였으므로 CPU 한도 초과도 시간 초과로 분류한다. 호스트는 5분 10초에 마지막으로 끊고, 이때는 로그가 없다.

**코드 실행은 자동으로 다시 하지 않는다.** 크롤러가 외부에 게시까지 하게 되므로 같은 실행이 두 번 일어나면 안 된다. 재시도는 web 크롤러의 페이지 가져오기(GET)에만 남는다.

### 외부 요청

**크롤러 코드의 `fetch`는 gateway를 거쳐 Cloudflare에서 나간다.** 새로 생기는 기능이다. 출발지가 Cloudflare라 일부 사이트는 거절할 수 있다(12절). gateway는 아래 규칙을 지킨다.
- `http:`와 `https:`만 허용한다.
- 주소 검사는 Lambda 목록보다 넓다. Lambda의 정규식은 Node `dns.lookup`이 돌려주는 점 표기만 맞추므로, URL이 정규화한 `[::ffff:7f00:1]` 같은 IPv6 표기를 놓친다. 그래서 주소를 바이트로 바꿔 CIDR로 비교한다(5절).
- `localhost`, `.localhost`로 끝나는 이름, 끝에 점이 붙은 같은 이름을 막는다.
- 리다이렉트는 gateway가 직접 따라가며 매 단계 다시 검사한다. origin이 바뀌면 인증 헤더를 지운다.
- `connect()`는 막는다.
- DNS 확인 뒤 실제 연결에서 다시 이름을 푸는 틈(DNS rebinding)은 남는다. Workers가 사설망에 닿지 못한다는 점에 기댄다.

**gateway와 crawler-manager는 요청 내용을 로그에 남기지 않는다.** 크롤러 코드는 키를 query string에 넣는 API를 부를 수 있다. gateway는 막은 요청의 hostname과 사유만 남기고 URL, query, 헤더, 본문은 남기지 않는다. gateway는 crawler-manager의 entrypoint이므로, 들어온 요청의 URL이 invocation log에 남을 수 있다. 그래서 crawler-manager의 `invocation_logs`를 끈다. 요청 기록은 이미 있는 `Request received` 로그(method, pathname)로 충분하다. 배포 뒤 Workers Logs에 크롤러 요청의 URL이 남지 않는지 확인한다(10절).

### 환경 변수

**환경 변수는 user-vault-worker에 둔다.** 이미 사용자 비밀(provider 키)을 envelope 암호화로 보관하고, KEK 교체 경로가 있으며, 공개 주소가 없다(`workers_dev = false`). 같은 D1에 테이블을 하나 더하고 같은 암호화 함수를 쓴다. 사용자 API는 JWT 인증이 있는 crawler-manager가 받아 service binding으로 vault에 넘긴다. KEK 재봉인(`/internal/keys/rewrap`)도 환경 변수까지 넓힌다. 그래야 KEK를 바꾸고 이전 KEK를 지워도 환경 변수가 열린다.

**환경 변수가 없는 사용자의 실행은 KEK 없이 지나간다.** 지금 vault는 KEK가 없으면 모든 route에 503을 낸다. 운영에는 vault 시크릿이 아직 없다(TES-143). 자기 크롤러를 실행할 때마다 vault를 읽으므로, 그대로 두면 운영의 기존 크롤러 실행이 모두 실패한다. 그래서 KEK 검사를 route별로 바꾼다.
- 환경 변수 `list`와 `delete`는 KEK가 필요 없다.
- `resolve`는 그 사용자의 행이 없으면 KEK 없이 `{}`를 돌려준다.
- 값을 다루는 `put`과 행이 있는 `resolve`만 KEK가 필요하다.

KEK 없이는 `put`이 실패해 행이 생길 수 없다. 따라서 TES-143 전에도 크롤러 실행은 지금처럼 돈다. 환경 변수 등록만 503이다.

**환경 변수 값은 결과와 로그에서 가린다.** 값은 4자 이상만 받는다. 더 짧은 값은 결과의 평범한 글자와 구별할 수 없어 가릴 수 없기 때문이다. 이렇게 하면 등록된 값은 모두 가려진다.
- 가리는 곳
  - 로그 메시지와 오류 문구. runner가 자르기 전에 한 번, 호스트가 한 번 가린다.
  - 결과의 문자열 값과 객체 키
  - 파일 이름
- 가리는 형태는 값 그대로, `JSON.stringify(value)`의 따옴표 안쪽(이스케이프된 형태), `encodeURIComponent(value)` 세 가지다. 원문과 같은 형태는 한 번만 센다. 모두 길이가 긴 순서로 `[REDACTED]`로 바꾼다(vault가 provider 오류를 가릴 때 쓰는 표시와 같다).
- 가리지 않는 곳: 파일 내용, 외부로 나가는 요청.
- crawler-manager는 가리기 전의 결과, 로그, 오류 문구를 어떤 logger에도 넘기지 않는다. 실패 로그에는 `crawlerID`와 `error_code`만 남긴다.

### 파일

**파일은 25 MiB까지이고, 호스트는 스트림으로 저장한다.** runner가 isolate 안에서 크기를 먼저 확인하고, 데이터를 `ReadableStream`과 크기로 넘긴다. 호스트는 `FixedLengthStream`을 거쳐 R2에 바로 쓴다. 이렇게 하면 crawler-manager isolate의 메모리에 파일 전체가 올라가지 않는다. crawler-manager는 여러 사용자의 요청을 함께 처리하므로 여기서 메모리를 넘기면 다른 실행까지 죽는다. 128kbps MP3 20분이 약 19 MB다. 총 용량 제한은 다음 단위(사용량 제한)에서 한다.

**파일 삭제는 큐 하나로 처리한다.** `crawler_files` 행이 지워지면 trigger가 R2 객체 키를 `crawler_file_deletions`에 넣는다. 행이 지워지는 경로는 세 가지다.
- 회차가 지워질 때(cascade)
- 사용자가 지워질 때(cascade)
- 직접 실행 파일의 기한이 지났을 때(cron)

cron은 큐에 쌓인 키를 R2에서 지운다. R2 lifecycle rule은 쓰지 않는다. 지우는 기준이 DB에 있으므로 한 곳에서 처리하는 편이 맞다. 행을 넣은 뒤 R2에 쓰는 사이에 행이 지워질 수 있으므로, 저장이 끝나면 행이 아직 있는지 다시 보고 없으면 객체를 바로 지운다.

### 직접 실행 기록

**직접 실행도 실행 기록을 남긴다.** 요구사항은 직접 실행과 스케줄 단계 모두에서 콘솔 출력과 오류가 실행 기록에 남으라고 한다. 지금 직접 실행에는 기록이 없으므로 `crawler_runs` 테이블을 더한다. 결과, 오류, 로그를 담고, 응답에 `run_id`를 넣는다. 보관 기한은 정하지 않는다(사용량 제한 단위에서 정한다).

## 3. 크롤러 코드가 쓰는 것

```js
async (input, context) => {
  const response = await fetch('https://api.example.com/v1/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${context.environment.SPEECH_API_KEY}` },
    body: JSON.stringify({ text: input.script }),
  });
  console.log('speech status', response.status);
  const audio = await context.files.save(await response.arrayBuffer(), {
    name: 'episode.mp3',
    contentType: 'audio/mpeg',
  });
  return { title: input.title, audio };
}
```

- **입력**: 지금과 같다. web 크롤러는 페이지 본문 문자열, data 크롤러는 앞 단계 출력이다. 기존 `(body) => ...` 코드는 그대로 동작한다.
- **`context.environment`**: 이름과 값이 담긴 얼린(frozen) 객체다. 자기 크롤러가 아니면 `{}`다.
- **`context.files.save(data, options?)`**
  - `data`: 문자열, `ArrayBuffer`, typed array, `DataView`, `Blob`, `ReadableStream`, 그 밖에 `new Response(data)`가 받는 값.
  - 25 MiB(26,214,400 bytes)를 넘으면 `File exceeds the maximum size of 26214400 bytes`를 던진다. `ReadableStream`은 읽으면서 세다가 넘는 순간 던진다.
  - `options.name`: 1~255자. 제어 문자(U+0000–U+001F, U+007F)가 있으면 `Invalid file name`이다. 없으면 `null`이다.
  - `options.contentType`: `^[A-Za-z0-9!#$&^_.+-]{1,127}/[A-Za-z0-9!#$&^_.+-]{1,127}(;[^\r\n]*)?$`이고 255자까지다. 틀리면 `Invalid content type`이다. 없으면 `application/octet-stream`이다.
  - 돌려주는 참조는 `{ file_id, name, content_type, size }`다. 평범한 객체라 결과에 넣으면 다음 단계에 그대로 넘어간다.
- **`context.files.read(reference)`**
  - `reference`는 참조 객체나 `file_id` 문자열이다.
  - `Response`를 돌려준다(`content-type`, `content-length` 헤더 포함).
  - 없는 파일, 남의 파일, 기한이 지난 파일은 모두 같은 오류(`File not found`)를 던진다.
- **실행 사용자가 없을 때와 실행이 끝난 뒤**: `save`와 `read`가 `Files are not available in this run`을 던진다. 실행 사용자가 없는 경우는 이름 실행(`executeCrawlerByName`)과 예전 `executeCrawler`다.
- **`fetch`**: 표준과 같다. 막힌 주소면 `TypeError`를 던진다. 본문이 있는 요청이 307이나 308을 받으면 따라가지 않고 그 응답을 그대로 돌려준다(5절).
- **`console`**
  - `log`, `info`, `warn`, `error`, `debug`는 같은 이름의 레벨로 남는다.
  - `dir`, `table`, `trace`는 `log` 레벨로 남는다.
  - `assert(condition, ...data)`는 조건이 거짓일 때만 `error` 레벨로 남는다.
  - 나머지(`group*`, `count*`, `time*`)는 아무것도 하지 않는다.
  - 결과를 돌려준 뒤에 찍은 로그와 처리되지 않은 Promise 거부는 남지 않는다.
- **반환값**: isolate 안에서 `JSON.stringify`를 거친다. `undefined`는 `null`이 된다. JSON으로 바꿀 수 없으면(BigInt, 순환 참조) 실패다.
- **`eval`, `new Function`**: Workers에서는 쓸 수 없다(`EvalError`).

## 4. 실행 (crawler-manager)

### 계약 (`workers/tools/sources/types.ts`)

```ts
export const CRAWLER_LOG_MAXIMUM_COST = 65_536;   // 항목마다 메시지 글자 수 + 64
export const CRAWLER_LOG_MAXIMUM_ENTRIES = 1_000;
export const CRAWLER_LOG_ENTRY_OVERHEAD = 64;

export type CrawlerLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

export interface CrawlerLogEntry {
  level: CrawlerLogLevel;
  message: string;
  timestamp: string; // ISO 8601
  item_index?: number; // fan-out 단계에서 스케줄러가 붙인다
}

export interface CrawlerRunContext {
  userUUID: string;
  runID?: string; // 스케줄 회차 ID. 없으면 직접 실행
}

export type CrawlerRunOutcome =
  | { status: 'completed'; type: 'web' | 'data'; result: unknown; logs: CrawlerLogEntry[]; logs_truncated: boolean }
  | {
      status: 'failed';
      type: 'web' | 'data';
      error_code: string;        // 아래 표
      error: string;             // 단계 실행 기록에 남는 문구. 지금 단계 실패 문구와 같은 형식
      error_description: string; // 설명만
      logs: CrawlerLogEntry[];
      logs_truncated: boolean;
    };

export function validateCrawlerRunOutcome(value: unknown): CrawlerRunOutcome;
```

- `validateCrawlerRunOutcome`이 던지는 오류 문구는 모두 `Invalid CrawlerRunOutcome:`으로 시작한다.
- 스케줄러의 `resolveHTTPStatus`는 지금 `Invalid CrawlerExecuteResult`에 주는 502를 이 문구에도 준다.
- 공통 함수 `resolveDefaultInput(inputSchema)`를 scheduler-manager에서 `workers/tools`로 옮긴다. 두 워커가 같은 함수를 쓰고, 동작은 지금과 같다.

### 오류

`error`는 지금 단계 실패 문구와 같다. 그래서 수동 스케줄 실행의 HTTP 상태(`resolveHTTPStatus`)가 그대로다.

| error_code | `error` | `error_description` | 직접 실행 상태 | 수동 스케줄 실행 상태 |
| -- | -- | -- | -- | -- |
| `invalid_input` | `Crawler <id>: no URL available. Provide url in input or set a default in input_schema.` (지금과 같고 접두어 없음) | 같은 문구 | 400 | 500 (지금과 같음) |
| Lambda의 코드 | `CodeRunnerExecutionError.message` 그대로 | `errorDescription` | 아래 규칙 | 502 또는 408 (지금과 같음) |
| `execution_failed` | `CodeRunner error 422: [execution_failed] <message>` | `<message>` | 422 | 502 |
| `execution_timeout` | `CodeRunner error 422: [execution_timeout] Code execution timed out after 300000ms` | 같은 설명 | 422 | 408 |

- `<message>`는 던진 값이 `Error`면 `message`, 아니면 `String(value)`다. 가린 뒤 2,000자까지 쓴다. 지금 Lambda도 `message`만 쓴다.
- CPU 한도 초과는 `execution_timeout`이다. 설명은 `Code execution timed out: CPU time limit of 30000ms exceeded`다. 런타임 오류 문구에 `CPU time limit`이 있거나 `exceeded CPU`가 있으면 CPU 한도 초과로 본다(대소문자 무시).
- 호스트 쪽 310초 제한에 걸린 것도 `execution_timeout`이다.
- 직접 실행에서 Lambda 코드의 상태 규칙
  - `invalid_request`는 400이다.
  - `fetch_timeout`은 504다.
  - 그 밖은 모두 502다. 상태 0(연결 실패)과 `invalid_response`, Lambda의 401, 403, 404, 413, 429가 여기에 든다.

### RPC

```ts
// 새 메서드. 스케줄러가 쓴다.
runCrawler(crawlerID: string, input: unknown, context: CrawlerRunContext): Promise<CrawlerRunOutcome>;

// 그대로 두는 메서드. 실행 사용자 없이 새 실행기로 돈다. 성공이면 { type, result }이고, failed면 Error(outcome.error)를 던진다.
executeCrawler(crawlerID: string, input: unknown): Promise<CrawlerExecuteResult>;
executeCrawlerByName(name: string, input: unknown): Promise<CrawlerExecuteResult>;
```

- 사용자 코드의 실패는 `failed` 결과로 돌려준다(로그를 함께 남기기 위해).
- 아래 경우는 던진다.
  - 크롤러가 없을 때: `Crawler <id> not found` (지금과 같다)
  - DB 오류
  - `context.userUUID`가 UUID가 아닐 때: `Invalid user UUID`
  - 자기 크롤러 실행에서 vault를 읽지 못했을 때
    - 문구는 `Environment variables could not be read: vault responded <상태> <error>`다. 연결이 안 되면 `Environment variables could not be read: vault could not be reached`다. 상태와 vault의 `error` 코드만 넣고 값이나 토큰은 넣지 않는다.
    - 스케줄 단계에서는 RPC가 던지는 다른 오류와 같다. 단계 실행 기록이 `failed`, `error`가 이 문구, `logs`는 `null`이 되고 실행 전체가 실패한다.
    - 직접 실행에서는 503 `service_unavailable`이고 `error_description`이 이 문구다. `crawler_runs`에는 남기지 않는다.
    - crawler-manager 로그에는 `crawlerID`, 사용자 UUID, vault 상태만 남긴다.
- `executeCrawler`는 배포 순서가 어긋난 동안 예전 스케줄러를 위해 남긴다. 머지 뒤 스케줄러 배포를 확인하면 지운다(12절).

### 실행 순서 (`sources/crawler-runtime/run-crawler.ts`)

`crawler-executor.ts`는 지운다. 그 안의 `resolveURL`과 `url_pattern` 경고는 그대로 `run-crawler.ts`로 옮긴다.

1. `getCrawlerByID`로 크롤러를 읽는다.
2. `ownsCrawler = context !== undefined && context.userUUID === crawler.user_uuid`. 시스템 크롤러는 시스템 사용자 소유라 언제나 거짓이다.
3. `ownsCrawler`면 vault `resolve`로 환경 변수 객체를 받는다. 아니면 `{}`이고 vault를 부르지 않는다.
4. web 크롤러면 입력을 만든다.
   - URL과 `url_pattern` 경고는 지금 `resolveURL`과 같다. URL이 없으면 `invalid_input`이다.
   - `new HTTPCodeRunnerClient(CODE_RUNNER_FUNCTION_URL).run('web', url, undefined, '(body) => body')`로 Lambda에서 본문을 받는다. 재시도와 30초 요청 제한이 지금과 같다.
   - 결과가 문자열이 아니면 `invalid_response` 실패다. `error`는 `CodeRunner error 502: [invalid_response] Expected the page body as a string`이다.
   - `CodeRunnerExecutionError`는 `failed` 결과가 된다(`error_code = errorCode`, `error = message`, `error_description = errorDescription`).
5. 코드 길이가 1,048,576자를 넘으면 `execution_failed`다. 저장할 때 이미 같은 값으로 검사한다.
6. `LOADER.get(isolateID, ...)`로 아래 `WorkerCode`를 올린다. 저장소의 `@cloudflare/workers-types`에는 `limits`가 없으므로 `WorkerLoaderWorkerCode & { limits: { cpuMs: number } }`로 타입을 넓힌다.

```ts
{
  compatibilityDate: '2025-11-25',
  compatibilityFlags: ['nodejs_als'],
  mainModule: 'runner.js',
  modules: {
    'runner.js': RUNNER_MODULE_SOURCE,                                  // 고정 문자열
    'crawler.js': { cjs: `module.exports = (\n${code}\n);` },
  },
  env: {},
  globalOutbound: exports.CrawlerOutboundGateway, // `cloudflare:workers`의 exports, props 없음
  limits: { cpuMs: 30_000 },
}
```

7. `getEntrypoint('CrawlerRunner').run(input, capabilities)`를 부른다.
   - `capabilities`는 `{ environment, files, timeoutMilliseconds: 300_000 }`다.
   - `files`는 실행 사용자가 있을 때만 `CrawlerFileCapability`이고, 없으면 `undefined`다.
   - 호스트 쪽 제한 시간은 310초다.
8. runner의 답을 결과로 바꾼다. `resultJSON`을 해석하고, 결과·로그·오류 문구를 다시 가린다. 그다음 `files.close()`를 부른다. 실패나 시간 초과로 끝나도 부른다.
9. 모듈을 올리거나 실행하다 던져진 오류(문법 오류 포함)는 `execution_failed`다. CPU 한도 초과는 위 규칙대로 `execution_timeout`이다.

### runner 모듈 (`sources/crawler-runtime/runner-module.ts`)

고정 JavaScript 문자열이다. `import crawler from './crawler.js'`로 CommonJS 모듈의 `module.exports`를 받는다.

- 모듈을 처음 읽을 때 `console`의 메서드를 한 번 바꾼다(3절의 대응). 현재 실행의 버퍼(`AsyncLocalStorage`)가 있으면 거기에 쌓고, 없으면 버린다.
- 메시지는 인자를 공백으로 이어 만든다.
  - 문자열은 그대로 쓴다.
  - `Error`는 `stack`을 쓰고, 없으면 `name: message`를 쓴다.
  - 그 밖의 값은 `JSON.stringify`를 쓰고, 실패하거나 `undefined`면 `String(value)`를 쓴다.
- 쌓기 전에 메시지를 가리고(`capabilities.environment`의 값, 2절의 세 형태), NUL을 `�`로 바꾼다.
- 한도는 2절과 같다(비용 합계 65,536, 항목 1,000개).
  - 비용이 넘는 항목은 남은 비용에서 64를 뺀 길이까지 메시지를 자른다. 남은 길이가 0 이하면 넣지 않는다.
  - 그 뒤의 항목은 버리고 `logsTruncated = true`로 표시한다.
- `export class CrawlerRunner extends WorkerEntrypoint`의 `run(input, capabilities)`:
  1. 실행 버퍼를 만들고 `AsyncLocalStorage.run` 안에서 실행한다.
  2. `context = Object.freeze({ environment: Object.freeze({ ...capabilities.environment }), files })`를 만든다.
  3. `crawler`가 함수가 아니면 실패다(`Crawler code must evaluate to a function`).
  4. `crawler(input, context)`를 부르고 `timeoutMilliseconds` 타이머와 경주시킨다.
  5. 성공하면 `{ ok: true, resultJSON, logs, logsTruncated }`를 돌려준다. `resultJSON = JSON.stringify(value === undefined ? null : value) ?? 'null'`이다.
  6. 실패하면 `{ ok: false, timedOut, errorMessage, logs, logsTruncated }`를 돌려준다. 이때 `stack`이 있으면 가린 뒤 로그 끝에 `error` 항목 하나로 더한다. 이 항목은 한도와 관계없이 4,000자까지 남긴다.

isolate 안의 `files`는 `capabilities.files`를 감싼 객체다. `capabilities.files`가 없으면 `save`와 `read` 모두 던진다.
- `save(data, options)`
  1. 데이터의 크기를 정한다.
     - `ArrayBuffer`, typed array, `DataView`는 `byteLength`다.
     - `Blob`은 `size`다.
     - `ReadableStream`은 읽으면서 세어 `Uint8Array`로 모으고, 한도를 넘으면 바로 던진다.
     - 그 밖은 `new Response(data).arrayBuffer()`의 길이다.
  2. 한도를 넘으면 던진다.
  3. `capabilities.files.save(new Response(bytes).body, { size, name, contentType })`를 부른다.
- `read(reference)`: `capabilities.files.read(fileID)`가 준 `{ body, content_type, size }`로 `Response`를 만든다.

### 파일 저장소 (`sources/crawler-runtime/file-capability.ts`)

`class CrawlerFileCapability extends RpcTarget`는 `#userUUID`, `#runID`, `#crawlerID`, `#supabaseClient`, `#bucket`, `#redactor`, `#closed`를 private 필드로 갖는다.

- `close()`: 이후의 호출을 막는다. RPC로 노출하지 않도록 `static` 함수나 모듈 함수로 만든다. 예: `closeFileCapability(capability)`.
- `save(stream, { size, name, contentType })`
  1. 닫혔으면 `Files are not available in this run`이다.
  2. `size`(0~26,214,400의 정수), 이름, 형식을 3절 규칙으로 검사한다. 이름은 가린 뒤 저장한다.
  3. `crawler_files` 행을 넣는다.
     - `id`는 `crypto.randomUUID()`, `object_key`는 `<userUUID>/<id>`다.
     - 직접 실행이면 `expires_at = now + 24h`, 회차 실행이면 `run_id = runID`다.
  4. `const { readable, writable } = new FixedLengthStream(size)`로 `stream.pipeTo(writable)`과 R2 `put(object_key, readable, { httpMetadata: { contentType } })`을 함께 기다린다.
  5. 실패하면 행을 지우고 `File could not be saved`를 던진다.
  6. 저장이 끝나면 행이 아직 있는지 확인한다. 없으면 R2 객체를 지우고 `File could not be saved`를 던진다.
  7. 참조를 돌려준다.
- `read(fileID)`
  1. 닫혔으면 `Files are not available in this run`이다.
  2. UUID가 아니면 `File not found`다.
  3. `user_uuid = userUUID`이고 기한이 지나지 않은 행을 찾는다.
  4. R2 `get`을 한다. 객체가 없으면 `File not found`다.
  5. `{ body: object.body, name, content_type, size }`를 돌려준다.

### 가리기 (`sources/crawler-runtime/redaction.ts`)

`createRedactor(environment)`는 값마다 2절의 세 형태를 만들고, 겹치지 않게 모아 길이가 긴 순서로 정렬해 둔다. 다음을 제공한다.
- `redactText(text)`
- `redactValue(value)`: 문자열, 배열, 객체 키와 값을 재귀로 처리한다.
- `redactLogs(entries)`

값이 없으면 입력을 그대로 돌려준다. runner 모듈 안에도 같은 규칙의 작은 함수를 둔다. runner는 문자열 소스라서 이 파일을 import할 수 없다.

## 5. 외부 요청 gateway (`sources/crawler-runtime/outbound-gateway.ts`)

`export class CrawlerOutboundGateway extends WorkerEntrypoint`를 `index.ts`에서 다시 export한다. `fetch(request)`는 `guardedFetch(request)`를 부른다. web 크롤러의 페이지 요청은 Lambda가 하므로 여기를 거치지 않는다.

주소 검사(`sources/crawler-runtime/address-policy.ts`)는 아래와 같다.
- IPv4와 IPv6 주소를 바이트로 바꿔 아래 범위와 비교한다.
  - 막는 IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`
  - 막는 IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`
  - IPv4를 품은 IPv6(`::ffff:0:0/96`, `::/96`, `64:ff9b::/96`, `2002::/16`)는 품은 IPv4를 꺼내 다시 검사한다.
- 해석할 수 없는 주소 문자열은 막는다.

`guardedFetch(request)`는 아래 순서로 처리한다.
1. URL을 검사한다.
   - 프로토콜이 `http:`나 `https:`가 아니면 `TypeError`(`Protocol '<p>' is not allowed. Only http: and https: are permitted`)다.
   - hostname에서 끝의 점을 떼고 소문자로 본다. `localhost`이거나 `.localhost`로 끝나면 `TypeError`(`The address of '<host>' is not allowed`)다.
2. 호스트가 IP literal이면(IPv6는 대괄호를 벗긴다) 그 주소를 검사한다.
3. 이름이면 DoH JSON API(`https://cloudflare-dns.com/dns-query?name=<host>&type=A`와 `type=AAAA`, `accept: application/dns-json`, 5초 제한)로 묻는다.
   - 답에서 type 1(A)과 28(AAAA) 레코드만 주소로 센다.
   - 주소가 하나도 없거나 요청이 실패하면 `TypeError`(`DNS lookup failed for '<host>'`)다.
4. 주소 하나라도 막힌 범위면 `TypeError`(`The address of '<host>' is not allowed`)다.
5. `redirect: 'manual'`로 보낸다. 본문은 스트림 그대로 넘기고 메모리에 모으지 않는다.
6. 응답이 3xx이고 `Location`이 있으면 원래 요청의 `redirect` 값에 따른다.
   - `manual`: 3xx를 그대로 돌려준다.
   - `error`: `TypeError`(`Redirect was not allowed`)다.
   - `follow`(기본): 아래 규칙으로 직접 따라간다.
     - 20번까지 따라가고, 넘으면 `TypeError`(`Too many redirects`)다. 매번 1~4를 다시 한다.
     - 301, 302는 POST일 때, 303은 GET·HEAD가 아닐 때 GET으로 바꾸고 본문을 뺀다. 이때 `content-type`, `content-length`, `content-encoding`, `content-language`, `content-location` 헤더도 지운다.
     - 307, 308은 메서드와 본문을 유지해야 한다. 본문이 없는 요청이면 따라간다. 본문이 있으면 다시 보낼 수 없으므로 따라가지 않고 그 3xx 응답을 그대로 돌려준다.
     - origin(scheme, host, port)이 바뀌면 `authorization`, `cookie`, `proxy-authorization`을 지운다.
7. `connect()`는 gateway가 받지 않으므로 실패한다.

DoH 요청과 실제 요청은 crawler-manager의 전역 `fetch`로 보낸다. gateway는 막은 요청의 hostname과 사유만 로그에 남긴다.

## 6. API (crawler-manager)

모두 JWT가 필요하다. 오류 본문은 지금 형식인 `{ error, error_description }`이다.

인증과 경로
- 새 route들은 공통 함수 `authenticate(request, environment)`를 쓴다. Bearer 토큰을 검증하고, `payload.sub`가 UUID가 아니면 401이다.
- `/crawlers/:id/runs`와 `/crawlers/:id/runs/:runID`는 지금의 `parseCrawlerID` 분기와 `Invalid crawler ID format` 404보다 먼저 맞춘다.
- `/files/:id`와 `/environment-variables[/:name]`은 `/crawlers` 분기 밖에 둔다.
- CORS preflight는 지금처럼 모든 경로에서 204다. 허용 메서드에 `PUT`과 `DELETE`가 이미 있다.

### 직접 실행 — `POST /crawlers/:id/runs`

- 본문은 없거나 `{ "input": <아무 JSON> }`이다. JSON이 아니거나 객체가 아니면 400 `invalid_request`다.
- `input`이 없으면 `resolveDefaultInput(crawler.input_schema)`로 만든다. 이 함수가 던지면 400 `invalid_request`다.
- 접근은 단계를 만들 때와 같은 규칙이다. `getCrawlerPermission`(owner 또는 subscriber)이 없으면 404 `Crawler not found`다.
- 실행 사용자는 요청한 사용자다. 환경 변수는 그 사용자가 작성자일 때만 넘어간다. 파일은 24시간 기한이다.
- 결과(완료나 실패)는 `crawler_runs`에 한 행으로 남긴다. 결과, 로그, 오류는 가린 값이다. 기록을 쓰지 못하면 로그에 남기고 응답의 `run_id`를 `null`로 둔다.
- 응답
  - 성공은 200 `{ run_id, status: 'completed', result, logs, logs_truncated }`다.
  - 실패는 4절 규칙의 상태로 `{ run_id, status: 'failed', error: <error_code>, error_description, logs, logs_truncated }`다.
  - vault를 읽지 못하면 503 `service_unavailable`이다.

### 직접 실행 기록 — `GET /crawlers/:id/runs/:runID`

- 그 사용자가 실행했고 그 크롤러의 기록일 때만 200으로 한 행 전체를 돌려준다.
- 아니면 404 `Crawler run not found`다.

### 파일 내려받기 — `GET /files/:id`

- 실행한 사용자만, 기한 안에서만 받을 수 있다. 아니면 404 `File not found`다.
- 200이면 본문 스트림과 함께 아래 헤더를 보낸다.
  - CORS 헤더(`createCORSHeaders`)
  - `Content-Type`, `Content-Length`
  - `X-Content-Type-Options: nosniff`
  - 이름이 있으면 `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded name>`와 `Access-Control-Expose-Headers: Content-Disposition`

### 환경 변수 — `/environment-variables`

| 요청 | 응답 |
| -- | -- |
| `GET /environment-variables` | 200 `{ data: [{ name, created_at, updated_at }] }` (이름순) |
| `PUT /environment-variables/:name` `{ value }` | 새로 만들면 201, 바꾸면 200 `{ name, created_at, updated_at }` |
| `DELETE /environment-variables/:name` | 200 `{ deleted: true }`, 없으면 404 `Environment variable not found` |

- 이름은 `^[A-Z_][A-Z0-9_]{0,63}$`이다. 틀리면 400 `Environment variable name must match ^[A-Z_][A-Z0-9_]{0,63}$`이다.
- 값은 4~16,384자 문자열이다. 틀리면 400 `Field 'value' must be a string of 4 to 16384 characters`다.
- 사용자당 100개까지다. 넘으면 409 `limit_exceeded`, `At most 100 environment variables are allowed`다.
- 값은 어떤 응답과 로그에도 나오지 않는다.
- vault 응답은 아래처럼 바꾼다.
  - vault 409는 409 `limit_exceeded`다.
  - vault 400은 500 `server_error`다. crawler-manager가 미리 검사했으므로 버그다.
  - 그 밖(401, 404, 503, 5xx, 연결 실패)은 503 `service_unavailable`이다.

## 7. 환경 변수 저장 (user-vault-worker)

`schema.sql`에 더한다.

```sql
CREATE TABLE IF NOT EXISTS environment_variables (
  user_id     TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  ciphertext  TEXT    NOT NULL,
  iv          TEXT    NOT NULL,
  wrapped_dek TEXT    NOT NULL,
  dek_iv      TEXT    NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (user_id, name)
);
```

내부 route를 더한다. 모두 POST JSON이다. 본문의 사용자 필드는 키 route와 같은 `userId`이고, `x-user-vault-token` 검사도 키 route와 같다.

| route | 본문 | 응답 | KEK |
| -- | -- | -- | -- |
| `/internal/environment-variables/list` | `{ userId }` | `{ variables: [{ name, created_at, updated_at }] }` | 필요 없음 |
| `/internal/environment-variables/put` | `{ userId, name, value }` | `{ name, created_at, updated_at, created }` | 필요 |
| `/internal/environment-variables/delete` | `{ userId, name }` | `{ deleted }` | 필요 없음 |
| `/internal/environment-variables/resolve` | `{ userId }` | `{ variables: { [name]: value } }` | 행이 있을 때만 |

- 검사 순서는 토큰 → route → JSON → `userId` → route별 본문 검사 → KEK 검사다. 지금 `handleRequest`는 route를 고른 뒤 바로 KEK를 검사하는데, 이 검사를 route 안으로 옮긴다. 키 route는 지금과 같이 KEK가 필요하다. KEK가 필요한데 없으면 같은 503 `vault_unavailable`이다.
- 이름과 값의 검사는 crawler-manager와 같은 규칙이다. 틀리면 400 `{ error: 'invalid_request' }`다.
- 암호화는 `sealProviderKey`/`openProviderKey`를 그대로 쓴다. binding은 `{ userID, provider: 'environment-variable:' + name, keyVersion, createdAt: updated_at }`다. 값을 바꿀 때마다 새로 봉인하고 `updated_at`을 바꾼다. `created_at`은 처음 값을 유지한다. `last4`는 저장하지 않는다.
- `put`
  - 이름이 있으면 바꾼다(`created: false`).
  - 없으면 한 문장으로 한도를 검사하며 넣는다. 예: `INSERT ... SELECT ... WHERE (SELECT COUNT(*) FROM environment_variables WHERE user_id = ?) < 100`.
  - 넣은 행이 없으면 409 `{ error: 'limit_exceeded' }`다.
  - 같은 이름을 동시에 넣다 기본 키가 충돌하면 바꾸기로 다시 한다.
- `resolve`에서 열리지 않는 행이 있으면 500 `{ error: 'decrypt_failed' }`다. 일부만 넘기지 않는다(fail-closed). 로그에는 사용자 ID와 이름만 남긴다.
- `/internal/keys/rewrap`은 그 사용자의 `environment_variables` 행도 같은 방식으로 다시 봉인한다. 응답에 `environment_variables_rewrapped`, `environment_variables_unrecoverable`을 더한다. 기존 `rewrapped`, `unrecoverable`은 provider 키만 센다.
- 감사 기록(`key_audit_log`)은 이번에 환경 변수로 넓히지 않는다(12절).
- 새 파일은 `sources/environment-variables.ts`다. 기존 `sources/environment.ts`(바인딩 타입)와 다른 파일이다. 시험용 `fake-database.ts`에 새 SQL 문장을 더한다.

crawler-manager 쪽 클라이언트는 `sources/user-vault-client.ts`다.
- 메서드는 `listEnvironmentVariables(userUUID)`, `putEnvironmentVariable(userUUID, name, value)`, `deleteEnvironmentVariable(userUUID, name)`, `resolveEnvironmentVariables(userUUID)`다.
- service binding `USER_VAULT`로 부른다.
- 시크릿 `VAULT_INTERNAL_TOKEN`이 비어 있지 않으면 헤더로 보낸다.
- 응답이 2xx가 아니면 `UserVaultError(status, code)`를 던진다. 연결 실패는 `status = 0`이다.

## 8. 스케줄러

- `CrawlerExecutionClient.execute`를 `run(crawlerID, input, context: CrawlerRunContext): Promise<CrawlerRunOutcome>`으로 바꾼다. `CRAWLER_MANAGER.runCrawler`를 부르고 `validateCrawlerRunOutcome`으로 검사한다.
- `StageRunnerDependencies`와 `ExecutorDependencies`에 `userUUID: string`을 더한다.
  - 수동 실행은 요청한 사용자다(소유자 확인을 거친 값).
  - 예약 실행은 `begin-run` step이 돌려준 `userUUID`다. 그 뒤 `{ ...dependencies, userUUID }`로 넘긴다.
- 함수 시그니처
  - `executeStage(dependencies, runID, stage, input, signal?)`: 그대로
  - `executePipelineStage(dependencies, runID, stage, input, signal?)`: 그대로
  - `executeFanOut(dependencies, runID, stage, items, concurrency?, signal?)`: `runID`를 두 번째 인자로 더한다
  - `run` 호출의 context는 `{ userUUID: dependencies.userUUID, runID }`다.
- 일반 단계
  - `completed`면 `output`, `logs`, `logs_truncated`를 기록한다.
  - `failed`면 `status: 'failed'`, `error = outcome.error`, `logs`, `logs_truncated`를 한 번 기록하고 `Error(outcome.error)`를 던진다. 이 경우 `executeStage`의 catch가 같은 단계를 다시 갱신하지 않는다. 실행 전체가 지금처럼 실패한다.
  - RPC가 던지면 지금과 같다(`logs`는 `null`).
- fan-out 단계
  - 항목마다 받은 로그에 `item_index`를 붙인다.
  - 실패한 항목(`failed` 결과나 던짐)은 `{ level: 'error', message: <error>, item_index, timestamp }`를 더한다. `failed` 결과면 그 항목의 로그도 함께 남긴다.
  - 합친 로그는 `item_index` 순서로 놓고, 같은 한도(비용 65,536, 항목 1,000)로 다시 자르고 NUL을 바꾼다.
  - 단계 기록에 `logs`와 `logs_truncated`를 남긴다. 성공·부분 실패 판정은 지금과 같다.
- 새 route `GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID`
  - 소유자만 볼 수 있다.
  - 단계 실행 기록 전체(`input`, `output`, `logs`, `logs_truncated`, `progress` 포함)를 돌려준다.
  - 그 회차의 기록이 아니면 404 `Stage run not found`다.
- `GET .../runs/:runID`의 `stage_runs` 요약
  - `logs`는 넣지 않고 `logs_truncated`는 넣는다.
  - 타입은 `Omit<SchedulerStageRunRow, 'input' | 'output' | 'logs'>`다.
- `resolveHTTPStatus`는 `Invalid CrawlerRunOutcome`도 502로 본다. 나머지는 그대로다.
- 작업 그룹 단계는 그대로다(`logs`는 `null`).

## 9. 데이터 (migration 013)

`packages/supabase-connector/migrations/013_add_crawler_runtime.sql`

```sql
ALTER TABLE scheduler_stage_runs
  ADD COLUMN logs JSONB,
  ADD COLUMN logs_truncated BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT scheduler_stage_runs_logs_check CHECK (logs IS NULL OR jsonb_typeof(logs) = 'array');

CREATE TABLE crawler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  crawler_id UUID NOT NULL REFERENCES crawlers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  result JSONB,
  error_code TEXT,
  error TEXT,
  logs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(logs) = 'array'),
  logs_truncated BOOLEAN NOT NULL DEFAULT false,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (completed_at >= started_at),
  CHECK ((status = 'failed') = (error IS NOT NULL AND error_code IS NOT NULL))
);

CREATE INDEX crawler_runs_crawler_id_created_at_index ON crawler_runs (crawler_id, created_at DESC);
CREATE INDEX crawler_runs_user_uuid_index ON crawler_runs (user_uuid);
ALTER TABLE crawler_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE crawler_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_uuid UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
  run_id UUID REFERENCES scheduler_runs(id) ON DELETE CASCADE,
  crawler_id UUID REFERENCES crawlers(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255),
  content_type TEXT NOT NULL CHECK (char_length(content_type) BETWEEN 1 AND 255),
  size BIGINT NOT NULL CHECK (size >= 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 회차 파일은 회차와 함께, 직접 실행 파일은 기한에 지운다
  CONSTRAINT crawler_files_lifetime_check CHECK ((run_id IS NULL) = (expires_at IS NOT NULL))
);

CREATE INDEX crawler_files_user_uuid_index ON crawler_files (user_uuid);
CREATE INDEX crawler_files_run_id_index ON crawler_files (run_id);
CREATE INDEX crawler_files_expires_at_index ON crawler_files (expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE crawler_files ENABLE ROW LEVEL SECURITY;

CREATE TABLE crawler_file_deletions (
  object_key TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX crawler_file_deletions_queued_at_index ON crawler_file_deletions (queued_at);
ALTER TABLE crawler_file_deletions ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION queue_crawler_file_deletion() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.crawler_file_deletions (object_key)
  VALUES (OLD.object_key)
  ON CONFLICT (object_key) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER crawler_files_queue_deletion
  AFTER DELETE ON crawler_files
  FOR EACH ROW EXECUTE FUNCTION queue_crawler_file_deletion();

-- 기한이 지난 직접 실행 파일 행을 batch_limit개까지 지우고 지운 개수를 돌려준다
CREATE FUNCTION delete_expired_crawler_files(batch_limit INTEGER) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.crawler_files
  WHERE id IN (
    SELECT id FROM public.crawler_files
    WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    ORDER BY expires_at
    LIMIT batch_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- R2에서 지운 키를 큐에서 뺀다
CREATE FUNCTION delete_crawler_file_deletions(object_keys TEXT[]) RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.crawler_file_deletions WHERE object_key = ANY (object_keys);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- 011과 같다: 서비스 역할(워커)만 부를 수 있다
REVOKE EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) FROM anon, authenticated;
    REVOKE EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) FROM anon, authenticated;
    GRANT EXECUTE ON FUNCTION delete_expired_crawler_files(INTEGER) TO service_role;
    GRANT EXECUTE ON FUNCTION delete_crawler_file_deletions(TEXT[]) TO service_role;
  END IF;
END;
$$;
```

connector에 더하는 것
- `sources/crawler-files.ts`
  - `createCrawlerFile`
  - `getCrawlerFileForUser(id, userUUID)`: 기한이 지나지 않은 것만
  - `crawlerFileExists(id)`
  - `deleteCrawlerFile(id)`
  - `deleteExpiredCrawlerFiles(limit)`: RPC `delete_expired_crawler_files`
  - `listCrawlerFileDeletions(limit)`: `queued_at` 오래된 순
  - `deleteCrawlerFileDeletions(objectKeys)`: RPC `delete_crawler_file_deletions`
- `sources/crawler-runs.ts`
  - `createCrawlerRun`
  - `getCrawlerRunForUser(id, crawlerID, userUUID)`
- 타입: `CrawlerFileRow`, `CrawlerRunRow`, `database.ts`의 테이블·함수 정의
- `updateSchedulerStageRun`은 `logs`와 `logs_truncated`를 받는다. `SchedulerStageRunRow`에 두 필드를 더한다. `SchedulerStageRunSummary`는 `logs`를 빼고 요약 컬럼 목록에 `logs_truncated`를 더한다.

## 10. 정리 cron과 배포

crawler-manager `wrangler.toml`에 더한다.

```toml
[[worker_loaders]]
binding = "LOADER"

[[r2_buckets]]
binding = "CRAWLER_FILES"
bucket_name = "audio-underview-crawler-files"

[[services]]
binding = "USER_VAULT"
service = "audio-underview-user-vault-worker"

[triggers]
crons = ["*/15 * * * *"]

# Secrets: VAULT_INTERNAL_TOKEN (optional, the vault's value). CODE_RUNNER_FUNCTION_URL stays: web crawlers still fetch pages through it.
```

`[observability.logs]`의 `invocation_logs`는 `false`로 바꾼다(2절).

`scheduled()`(`sources/file-cleanup.ts`)는 아래 세 단계를 한다. 단계마다 따로 `try/catch`로 감싸, 하나가 실패해도 다음 단계를 한다. 마지막에 하나라도 실패했으면 던진다.
1. `deleteExpiredCrawlerFiles(500)`로 기한이 지난 직접 실행 파일 행을 지운다. trigger가 큐에 넣는다.
2. `listCrawlerFileDeletions(500)`로 키를 읽어 R2 `delete(keys)`를 한다.
3. R2가 성공하면 `deleteCrawlerFileDeletions(keys)`로 그 큐 행을 지운다. R2가 실패하면 큐 행을 남겨 다음 cron에서 다시 한다.

### 사람이 할 일 (머지 전, 이 순서로)

1. 배포 계정에 Workers Paid를 켠다. Dynamic Workers는 Workers Paid 계정에서만 열린 open beta다.
2. R2 버킷 `audio-underview-crawler-files`를 만든다.
3. migration 013을 브랜치에서 먼저 적용한다(`deploy-database-migrations.yml`).
4. vault D1에 `environment_variables` 테이블을 만든다. `schema.sql`을 원격 D1에 실행하면 되고, `IF NOT EXISTS`라 다시 실행해도 된다.
5. `VAULT_INTERNAL_TOKEN`은 vault와 crawler-manager에 같은 값으로 넣는다.
   - 순서는 crawler-manager 먼저, vault 나중이다. vault는 토큰이 없으면 헤더를 보지 않으므로, crawler-manager에 먼저 넣어도 실패하지 않는다.
   - vault에만 넣으면 `resolve`가 401이 되어, 자기 크롤러 실행이 모두 4절의 vault 오류로 실패한다.
   - TES-143에서 vault 시크릿을 넣을 때도 이 순서를 따른다. PR 본문에도 적는다.
   - 운영 vault 시크릿 4개(`PROVIDER_KEY_KEK` 등)는 아직 등록되지 않았다(TES-143). 등록 전까지 환경 변수 등록(`PUT`)은 503이고, 운영에서 환경 변수 기능을 확인할 수 없다. 환경 변수가 없는 사용자의 크롤러 실행은 KEK 없이 돈다(2절). PR 본문에도 이 점을 적는다.
6. vault를 브랜치에서 먼저 배포한다(`deploy-user-vault-worker.yml`을 브랜치 ref로 dispatch).
   - 머지하면 vault, crawler-manager, 스케줄러가 순서 없이 함께 배포되기 때문이다.
   - 예전 vault에는 환경 변수 route가 없어서, 새 crawler-manager가 먼저 뜨면 자기 크롤러 실행이 모두 실패한다.
   - 배포 뒤 `/internal/environment-variables/resolve`가 200인지 확인한다.
7. crawler-manager를 브랜치에서 배포한다(`deploy-crawler-workers.yml`). 예전 스케줄러는 남겨 둔 `executeCrawler`를 부르고, 이 경로는 vault를 읽지 않는다.
8. 머지한다. 스케줄러는 머지할 때 배포된다.

### 배포 뒤 확인

- 시스템 크롤러 하나와 사용자 크롤러 하나를 직접 실행해 결과와 로그가 오는지 본다.
- Workers Logs에 크롤러 코드가 보낸 요청의 URL이 남지 않는지 본다. 남는다면 gateway를 별도 Worker로 나누는 방안을 정한다.
- CPU 한도(`limits.cpuMs`)가 실제로 끊는지 본다(로컬에서는 강제되지 않는다).

## 11. 테스트

### 고치는 기존 테스트

계약이 바뀌는 아래 테스트만 고친다. 그 밖의 기존 테스트는 고치지 않고 통과해야 한다. 고칠 때도 기존 사례를 지우지 않고, 기대값은 바뀐 계약만큼만 바꾼다.

- `workers/crawler-manager-worker/tests/index.test.ts`의 `executeCrawlerByName` 성공 사례
  - Lambda 요청 본문이 `(body) => body`이고 결과가 본문 문자열이다.
  - 코드는 `LOADER`에서 실행된다.
- `workers/crawler-manager-worker/tests/crawler-executor.test.ts`: `crawler-executor.ts`와 함께 지운다. `resolveURL`과 `url_pattern` 사례는 새 실행기 테스트로 옮긴다.
- scheduler-manager의 `execute` mock을 쓰는 테스트(`stage-runner.test.ts`, `scheduler-executor.test.ts`, `scheduled-pipeline.test.ts`, `manual-execution.test.ts` 등)
  - mock을 `run`으로 바꾸고, `{ status: 'completed', type, result, logs: [], logs_truncated: false }`를 돌려준다.
  - 던지는 mock은 그대로 둔다.
  - 호출 단언에 `{ userUUID, runID }`를 더한다.
  - `CRAWLER_MANAGER.executeCrawler` 단언은 `runCrawler`로 바꾼다.
  - `executeFanOut` 호출에 `runID`를 더한다.

### 시험 환경

- crawler-manager의 `LOADER`와 R2는 `wrangler.toml`의 실제 로컬 바인딩을 쓴다. runner 모듈을 실제로 돌려야 로그 순서, ALS, 시간 초과를 시험할 수 있다.
- `USER_VAULT`는 `vitest.config.ts`의 `miniflare.workers`에 이름 `audio-underview-user-vault-worker`인 보조 worker로 둔다(스케줄러의 `CRAWLER_MANAGER`와 같은 방식). 시험마다 응답을 바꿀 수 있게 만든다.
- Supabase와 Lambda는 지금처럼 `fetchMock`이다.
- gateway의 DoH와 실제 요청이 `fetchMock`에 잡히지 않으면 `vi.spyOn(globalThis, 'fetch')`로 바꾼다.
- 시스템 크롤러 코드는 migration 010을 Vite `?raw` import로 읽는다. workerd에서는 `node:fs`를 쓸 수 없다. 코드 길이와 SHA 검사는 기존 Lambda 시험에 남긴다.
- migration 013은 PGlite로 확인하되, 저장소 밖의 스크립트로 한다(새 의존성 없음).

### crawler-manager — 실행기

- 실행과 입출력
  - data와 web 크롤러를 실행하고 결과를 확인한다.
  - 기존 `(body) => ...` 코드가 바뀌지 않고 동작한다.
  - sloppy mode 코드가 동작한다: `(body) => { counter = 1; return counter; }`.
  - `eval`은 `execution_failed`다.
  - `undefined`는 `null`이 된다.
  - JSON으로 못 바꾸는 결과, 문법 오류, 함수가 아닌 코드는 `execution_failed`다.
  - `invalid_input`의 `error` 문구는 접두어가 없다.
- 로그
  - 3절의 console 대응대로 순서대로 남는다.
  - 비용 한도와 1,000개 한도에서 자르고 `logs_truncated`가 된다. 빈 메시지 반복도 1,000개에서 멈춘다.
  - NUL을 바꾼다.
  - 동시 실행 두 개의 로그가 섞이지 않는다.
  - 실패하면 `stack`이 로그 끝에 남는다.
- 시간
  - 비동기 대기가 제한 시간을 넘으면 그때까지의 로그와 함께 `execution_timeout`이다. 시험에서는 제한 시간을 주입한다.
  - CPU 한도 오류 문구는 `execution_timeout`으로 분류한다(분류 함수 단위 시험).
  - `LOADER.get`의 `WorkerCode`에 `limits.cpuMs`와 `cjs` 모듈이 들어간다(spy).
- isolate ID
  - 사용자가 다르면 ID가 다르다.
  - 같은 사용자와 같은 코드면 ID가 같다.
  - 설정이 바뀌면 ID가 바뀐다.
- 환경 변수
  - 작성자 실행에서는 `context.environment`에 값이 있다.
  - subscriber 실행, 시스템 크롤러, 이름 실행, `executeCrawler`에서는 `{}`이고 vault를 부르지 않는다.
  - vault가 실패하면 4절의 문구로 던진다.
- 가리기
  - 로그, 오류 문구, `stack`, 결과의 문자열 값과 객체 키, 파일 이름에서 가린다.
  - JSON 이스케이프 형태와 URL 인코딩 형태도 가린다.
  - 긴 값을 먼저 가린다.
  - 한도 경계에서 잘린 로그에도 값의 앞부분이 남지 않는다(자르기 전에 가림).
  - 값이 든 오류로 실행한 뒤 crawler-manager logger의 어떤 호출 인자에도 값이 없다.
- 파일
  - 저장하고 읽고 다음 실행에서 참조로 읽는다.
  - 남의 파일, 기한이 지난 파일, 없는 파일은 같은 오류다.
  - 25 MiB를 넘거나(ArrayBuffer, Blob, ReadableStream 각각), 형식이나 이름이 틀리면 거절한다.
  - R2 put이 실패하면 행이 지워진다.
  - put 뒤 행이 없으면 객체가 지워진다.
  - 직접 실행이면 `expires_at`, 회차 실행이면 `run_id`가 들어간다.
  - 실행 사용자가 없을 때와 `close()` 뒤에는 `Files are not available in this run`이다.
  - isolate 안에서 `capabilities.files`의 내부 필드(`supabaseClient`, `bucket` 등)를 읽을 수 없다.
- gateway
  - 막는 것
    - IP literal: `127.0.0.1`, `10.0.0.1`, `100.64.0.1`, `[::1]`, `[::]`, `[::ffff:7f00:1]`, `[::ffff:127.0.0.1]`, `[::7f00:1]`, `[64:ff9b::a00:1]`, `[fd00::1]`
    - DoH가 사설 주소를 돌려주는 이름
    - `localhost`, `localhost.`, `foo.localhost`
    - `ftp:`
    - 사설 주소로 가는 리다이렉트, 20번 넘는 리다이렉트
    - `connect()`
  - 허용하는 것: 공개 주소, 리다이렉트 따라가기(303 → GET, 본문과 `content-*` 헤더 제거), `redirect: 'manual'`.
  - origin이 바뀌는 리다이렉트에서 `authorization`, `cookie`가 지워지고, 같은 origin에서는 남는다.
  - 본문이 있는 307은 따라가지 않고 그대로 돌려준다.
  - DoH 실패, CNAME만 있는 답.
  - gateway 로그에 URL과 query가 없다.
- web 크롤러의 페이지 가져오기
  - Lambda `/run`에 `type: 'web'`, URL, `(body) => body`를 보낸다.
  - Lambda의 400, 502, 504와 연결 실패가 지금과 같은 `error` 문구의 `failed` 결과가 된다.
  - 받은 본문으로 크롤러 코드를 실행한다.
- 시스템 크롤러 5개: `functions/crawler-code-runner-function/tests/system-crawlers.test.ts`의 고정 입력과 기대값을 새 실행기로 돌린다. 페이지 가져오기는 Lambda 그대로이므로 실제 사이트 요청은 바뀌지 않는다.

### crawler-manager — API

- 직접 실행
  - 인증이 없거나 `sub`가 UUID가 아니면 401이다.
  - 권한(owner, subscriber, 없음)에 따라 동작이 다르다.
  - 본문이 없으면 기본 입력으로 실행하고, 기본 입력을 만들 수 없으면 400이다.
  - 실패의 상태 코드(4절 규칙)와 본문, vault 503을 확인한다.
  - `crawler_runs`에 남고 응답에 `run_id`가 있다. 기록이 실패하면 `run_id`가 `null`이다.
  - 실행 기록 조회는 실행한 사용자만 하고, 다른 크롤러의 기록은 404다.
- 파일 내려받기
  - 소유자만, 기한 안에서만 받는다.
  - 헤더를 확인한다.
- 환경 변수
  - 이름과 값 검사(3자 값은 400), 201과 200, 404, 409, vault 400 → 500, 그 밖 → 503을 확인한다.
  - 값이 어떤 응답에도 나오지 않는다.
- cron
  - 기한이 지난 행을 지운다.
  - 큐를 비운다.
  - R2가 실패하면 큐가 남는다.
  - 한 단계가 실패해도 다음 단계를 하고 마지막에 던진다.

### user-vault-worker

- 넣기, 바꾸기(`created_at` 유지), 목록, 지우기, `resolve`가 동작한다.
- 다른 사용자나 다른 이름의 행으로 바꿔 끼운 암호문은 열리지 않는다(AAD).
- 100개 한도와 이미 있는 이름 바꾸기는 한도와 관계없음을 확인한다.
- 열리지 않는 행이 있을 때의 `resolve`와 토큰 검사를 확인한다.
- 목록과 넣기 응답에 값이 없다.
- KEK가 없을 때
  - 키 route와 환경 변수 `put`은 503 `vault_unavailable`이다.
  - `list`, `delete`, 행이 없는 `resolve`는 동작한다.
  - 행이 있는 `resolve`는 503이다.
- `rewrap`이 환경 변수도 다시 봉인하고 새 KEK로 열린다.
- 기존 키 route의 응답과 순서가 바뀌지 않는다.

### scheduler-manager-worker

- `run`에 `userUUID`와 `runID`가 넘어간다(수동과 예약, 일반과 fan-out 모두).
- 성공과 실패 단계에 `logs`가 기록된다.
- 실패 단계는 한 번만 갱신되고, 실행 전체가 실패한다.
- fan-out
  - `item_index`를 붙인다.
  - 실패 항목을 오류 로그로 남긴다.
  - 한도로 다시 자른다.
- 단계 실행 상세 route를 확인한다(소유자, 다른 회차 404).
- 실행 요약에 `logs`가 없고 `logs_truncated`가 있다.
- `resolveHTTPStatus`가 지금과 같은 상태를 낸다. `Invalid CrawlerRunOutcome`은 502다.

### connector와 migration

- connector 함수를 단위 시험한다.
- PGlite로 013을 적용해 확인한다.
  - 회차를 지우면 파일 행이 지워지고 큐에 키가 들어간다.
  - lifetime check가 동작한다.
  - 사용자를 지우면 cascade된다.
  - `logs` 형식을 검사한다.
  - `crawler_runs`의 상태와 오류 check가 동작한다.
  - 두 RPC 함수의 결과와 권한을 확인한다.

## 12. 기존 동작과 달라지는 점, 이번에 하지 않는 것

### 달라지는 점

| 항목 | 지금 | 바뀐 뒤 |
| -- | -- | -- |
| `eval`, `new Function` | 동작 | `EvalError` (`execution_failed`) |
| 결과가 `undefined` | Lambda 응답에 `result`가 없어 `invalid_response`로 실패 | `null`로 성공 |
| 페이지 크기 | 코드가 줄인 결과가 6 MB 안이면 성공 | 본문 자체가 6 MB(Lambda 응답 한도)를 넘으면 실패 |
| 두 번째 인자 | 없음 | `context`. `(body, options = {}) =>`처럼 두 번째 인자를 기본값으로 쓰던 코드는 `context`를 받는다 |
| 실행 시간, 코드 길이 | 5초, 1만 자 | 5분(CPU 30초), 1,048,576자 |
| 크롤러 코드 실행 재시도 | 5xx면 두 번 더 | 없음(페이지 가져오기만 재시도) |

### 이번에 하지 않는 것

| 항목 | 상태 | 원인 | 이어 붙일 단위 |
| -- | -- | -- | -- |
| 웹 편집기의 시험 실행 | 미접속 | 아직 Lambda를 직접 부른다(5초, 1만 자, `fetch` 없음). `POST /crawlers/:id/runs`로 옮겨야 새 기능을 시험할 수 있다 | 웹 스케줄 편집기 |
| 환경 변수 등록, 로그·파일·실행 기록 보기 화면 | 미접속 | 웹 범위 밖 | 웹 스케줄 편집기 |
| 사용량 제한(실행, 시간, 저장 용량, 외부 요청)과 `crawler_runs` 보관 기한 | 미접속 | 요구사항에서 다음 단위로 미룸 | 다음 단위 |
| 환경 변수 감사 기록 | 미접속 | `key_audit_log`는 provider 키만 다룬다 | 필요해지면 |
| 크롤러 코드의 `fetch` 출발지 | 미접속 | Cloudflare에서 나가므로 `CF-Worker` 헤더가 붙고, 일부 사이트(프로토타입에서 GeekNews)가 거절할 수 있다. 페이지 가져오기는 web 크롤러로 하면 Lambda에서 나간다 | 문제가 생기면 Lambda 경유 요청을 더한다 |
| 운영 환경 변수 기능 | 끊김 | 운영 vault 시크릿이 없어 등록이 503이다 | TES-143 |
| 시간 초과 뒤의 외부 요청 | 미접속 | 시간 초과로 기록한 뒤에도 isolate의 코드가 외부 요청을 계속할 수 있다. 파일 저장은 막힌다 | 필요해지면 |
| 크롤러 단계만 있는 수동 실행의 5분 제한 | 끊김 가능 | 요청 안에서 파이프라인 전체에 5분을 건다. 5분을 다 쓰는 크롤러 하나로도 넘을 수 있다 | 필요해지면 Workflow로 넘긴다 |
| 예약 실행 fan-out 단계의 15분 제한 | 끊김 가능 | 단계 하나가 Workflow step 하나(15분)다. 항목을 차례로 돌리므로 몇 분짜리 크롤러 항목이 많으면 넘는다 | 필요해지면 step을 나눈다 |
| `executeCrawler` RPC와 `crawler-code-runner-worker` 정리 | 미접속 | `executeCrawler`는 배포 순서를 위해 남긴다. `crawler-code-runner-worker`는 배포된 적 없다 | 머지 뒤 |

## 13. 확인한 외부 사실

- Dynamic Workers는 2026-03-24부터 Workers Paid 사용자 대상 open beta다. 요청과 CPU는 Workers 요금으로 청구된다. 만든 Worker 수에 따른 요금은 아직 걷지 않는다.
- `load()`와 `get()`의 차이는 아래와 같다.
  - `load()`는 매번 새로 만든다.
  - `get(id, callback)`은 ID로 캐시하고, 같은 ID에는 같은 코드와 설정을 돌려줘야 한다.
  - 같은 stub이라도 다른 isolate로 갈 수 있다.
- `globalOutbound`
  - `null`이면 막힌다.
  - `ctx.exports`의 entrypoint를 주면 `fetch()`와 `connect()`가 그쪽으로 간다.
- `env`에는 structured clone 가능한 값과 service binding을 넣을 수 있다.
- `limits: { cpuMs, subRequests }`를 넘으면 isolate가 바로 예외를 던진다.
- Worker 요청 하나에 동시에 실행되는 Dynamic Worker는 4개까지다(같은 Worker로 가는 요청 여럿은 하나로 센다).
- 로그를 Tail Worker로 받으면 실행이 끝난 뒤 비동기로 온다. Dynamic Worker의 console 출력은 기본으로 parent의 Workers Logs에 남지 않는다.
- RPC 직렬화 한도는 32 MiB다. `ReadableStream`은 이 한도를 받지 않는다. RPC 인자로 받은 stub은 호출이 끝나면 dispose된다.
- R2는 prefix별 만료 일수를 lifecycle rule로 걸 수 있지만, 이 설계는 쓰지 않는다.
- Lambda 동기 호출의 payload는 6 MB까지다(Invoke API 문서). function URL만 따로 적은 한도는 찾지 못했다. web 크롤러의 본문을 Lambda에서 그대로 받으므로 이 한도가 사실상 페이지 크기 한도가 된다.
- Workers의 메모리는 isolate마다 128 MB다(Free·Paid 같음).
- 로컬 확인(이 저장소의 vitest-pool-workers 0.12.10, workerd 1.20260205.0)
  - `globalOutbound`에 넘긴 `exports` entrypoint가 isolate의 `fetch`를 받았다(props 전달 포함).
  - `run` 인자 객체 안에 넣은 `RpcTarget`의 메서드 호출과 `ReadableStream` 반환이 동작했다.
  - `RpcTarget`의 공개 필드와 `#private` 필드는 isolate에서 읽을 수 없었다. 메서드만 보였다(`The RPC receiver does not implement the method`).
  - `nodejs_als`의 `AsyncLocalStorage`로 동시 실행 두 개의 로그가 섞이지 않았다.
  - `connect()`는 gateway를 거쳐 실패했다.
  - `{ cjs }` 모듈은 sloppy mode였다. 선언 없는 대입, 8진수 리터럴, `arguments.callee`, `with`가 동작했다. 같은 코드를 `{ js }` 모듈로 올리면 실패했다.
  - `eval`과 `new Function`은 두 모듈 모두 `EvalError: Code generation from strings disallowed for this context`였다.
  - `limits.cpuMs`는 로컬에서 강제되지 않아 무한 루프가 끝나지 않았다. 저장소의 `@cloudflare/workers-types` 4.20260207.0의 `WorkerLoaderWorkerCode`에는 `limits` 필드가 없다.

출처
- https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/
- https://developers.cloudflare.com/dynamic-workers/api-reference/
- https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
- https://developers.cloudflare.com/dynamic-workers/usage/limits/
- https://developers.cloudflare.com/dynamic-workers/usage/observability/
- https://developers.cloudflare.com/dynamic-workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/
- https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html
- https://developers.cloudflare.com/workers/platform/limits/
