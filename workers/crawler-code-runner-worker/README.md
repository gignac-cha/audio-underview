# crawler-code-runner-worker

URL을 fetch한 뒤 사용자가 전달한 JavaScript 코드를 샌드박스 환경에서 실행하여 결과를 반환하는 Cloudflare Worker입니다.

> **Note:** 현재 Cloudflare의 `WorkerLoader` API 제한으로 인해 배포가 불가능한 상태입니다. 동일한 기능을 AWS Lambda로 구현한 [crawler-code-runner-function](../../functions/crawler-code-runner-function/)을 사용하세요.

## Lambda 버전과의 차이점

| | Worker (Cloudflare) | Function (AWS Lambda) |
|---|---|---|
| 코드 실행 | `WorkerLoader` 샌드박스 (격리된 Worker) | `new Function()` (동일 프로세스) |
| 런타임 | Cloudflare Workers | Node.js 24.x |
| 환경변수 | `wrangler.toml` 또는 대시보드 | Lambda 환경변수 |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | 도움말 반환 |
| GET | `/help` | 도움말 반환 |
| POST | `/run` | URL fetch 후 코드 실행 |
| OPTIONS | `/run` | CORS preflight |

## POST /run

### Request Body

```json
{
  "type": "test | run",
  "url": "fetch할 대상 URL",
  "code": "response body를 인자로 받는 JavaScript 함수 문자열"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"test"` \| `"run"` | 실행 모드 |
| `url` | `string` | fetch할 대상 URL |
| `code` | `string` | `(body: string) => any` 형태의 함수 문자열. `body`는 fetch된 HTML/텍스트 |

### Response

```json
{
  "type": "test",
  "result": "<코드 실행 결과>"
}
```

## curl 사용 예시

### 도움말 조회

```bash
curl -s <WORKER_URL>/help
```

### 페이지 제목 파싱

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{
    "type": "test",
    "url": "https://example.com",
    "code": "(body) => body.match(/<title>(.*?)<\\/title>/)?.[1]"
  }' \
  <WORKER_URL>/run
```

### HTML 본문 길이 확인

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{
    "type": "test",
    "url": "https://example.com",
    "code": "(body) => body.length"
  }' \
  <WORKER_URL>/run
```

### 목록 항목 추출

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{
    "type": "test",
    "url": "https://example.com",
    "code": "(body) => { const items = [...body.matchAll(/<li>(.*?)<\\/li>/gs)].map(m => m[1].replace(/<[^>]*>/g, \"\").trim()).filter(t => t.length > 0); return items.slice(0, 10); }"
  }' \
  <WORKER_URL>/run
```

## Error Responses

| Status | Error Code | Description |
|--------|-----------|-------------|
| 400 | `invalid_request` | JSON 파싱 실패 또는 필수 필드 누락 |
| 404 | `not_found` | 존재하지 않는 엔드포인트 |
| 422 | `execution_failed` | 코드 실행 중 오류 발생 |
| 500 | `server_error` | 서버 내부 오류 |
| 502 | `fetch_failed` | 대상 URL fetch 실패 |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ALLOWED_ORIGINS` | CORS 허용 origin 목록 (쉼표 구분) |
| `LOADER` | Cloudflare `WorkerLoader` 바인딩 |
