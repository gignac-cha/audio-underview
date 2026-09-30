# 03 시스템 크롤러 · 이름 호출

## 1. 만들 것

| 대상 | 내용 |
| -- | -- |
| `functions/crawler-code-runner-function` | web 타입 fetch에 요청 헤더 3개 추가(§2) |
| `packages/supabase-connector` | 마이그레이션 `010_create_system_crawlers.sql`(§3), `SYSTEM_USER_UUID`와 `getSystemCrawlerByName`(§5) |
| `workers/crawler-manager-worker` | RPC `executeCrawlerByName`(§6) |

기존 export·라우트·RPC·시그니처는 바꾸지 않는다. 의존성 추가는 없다.

## 2. code runner — 요청 헤더

`functions/crawler-code-runner-function/sources/index.ts`의 web 타입 fetch에 아래 헤더를 보낸다. data 타입과 그 밖의 동작은 그대로다.

| 헤더 | 값 |
| -- | -- |
| `user-agent` | `AudioUnderviewBot/1.0 (+https://audio-underview.pages.dev)` |
| `accept` | `text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8` |
| `accept-language` | `ko,en;q=0.8` |

`news.hada.io`는 라이브러리 기본 User-Agent(`node`, `undici`, `curl`)와 `crawler`가 들어간 값에 403을 돌려준다(2026-09-30 확인). 위 값은 200을 받는다. 값을 바꾸지 않는다.

## 3. 마이그레이션 `010_create_system_crawlers.sql`

`documents/migration/03-system-crawlers.sql`을 `packages/supabase-connector/migrations/010_create_system_crawlers.sql`로 **바이트 그대로 복사**한다(`cp`). 내용을 고치거나 다시 쓰지 않는다.

파일이 하는 일:
1. 시스템 사용자 행 `users.uuid = '00000000-0000-0000-0000-000000000001'`. `accounts` 행이 없어서 아무도 이 사용자로 로그인할 수 없다.
2. 부분 고유 인덱스 `crawlers_system_name_unique_index`: 시스템 사용자 소유 크롤러끼리는 `name`이 고유하다. 일반 사용자는 같은 이름을 쓸 수 있다.
3. 시스템 사용자 소유의 web 크롤러 5개. `input_schema`·`output_schema`는 컬럼 기본값이다.
4. 그 5개에 대한 `crawler_permissions`의 `owner` 행.

크롤러 코드는 ASCII만 쓴다. `$system_crawler$` 사이의 텍스트를 앞뒤 공백을 떼고(`trim`) 잰 값:

| name | url_pattern | 길이 | SHA-256 |
| -- | -- | -- | -- |
| `geeknews-list` | `^https://news\.hada\.io.*$` | 1910 | `97079ddee9bb08be76d01050ba3833c4b561bb49e950cac0899b08ae490771a0` |
| `geeknews-summary` | `^https://news\.hada\.io/topic.*$` | 2391 | `2b91aaa302aad451120713c68f08ca2221b313d9c0f8d00c91d2030165a132b3` |
| `article-content` | `^https?://.+$` | 2376 | `d45bbc28529f3eb72e6aeff7c4c8b1d07a091380b70237bc577913df82419d60` |
| `hn-search` | `^https://hn\.algolia\.com/api/v1/search.*$` | 527 | `6309c591c3e556dd870434fb6ed88ab06f22df637f41759ea6f7977493238ee7` |
| `hn-items` | `^https://hn\.algolia\.com/api/v1/items/.*$` | 1919 | `dddd2e1fbe9d880490f4ef5f9bfcc4799eee5a9d10fa0841bdda0bb6bcab92ef` |

## 4. 시스템 크롤러 계약

다섯 개 모두 web 타입이다. 입력은 `{ url }`이고, code runner가 그 URL을 가져와 본문 텍스트를 코드에 넘긴다.

| name | 입력 URL | 결과 |
| -- | -- | -- |
| `geeknews-list` | `https://news.hada.io/` | `[{ title, discussionUrl, originalUrl }]`. 제목이 없는 행은 뺀다. 목록이 없으면 `[]` |
| `geeknews-summary` | `https://news.hada.io/topic?id=<id>` | 글쓴이 요약 본문 텍스트. 댓글은 포함하지 않는다. 최대 8,000자. 없으면 `''` |
| `article-content` | 기사 URL | 본문 텍스트. `article`, `main`, `body` 순으로 가장 긴 영역을 쓴다. 최대 24,000자. HTML이 아니면 `''` |
| `hn-search` | `https://hn.algolia.com/api/v1/search?query=<기사 URL>&restrictSearchableAttributes=url&tags=story` | 점수가 가장 높은 글의 `{ objectID, itemsUrl }`. 없거나 JSON이 아니면 `null` |
| `hn-items` | `hn-search`가 준 `itemsUrl` | 삭제되지 않은 댓글을 위에서부터 너비 우선으로 최대 60개, 줄바꿈으로 이은 텍스트. 최대 20,000자. 없으면 `''` |

## 5. connector

`packages/supabase-connector/sources/crawlers.ts`에 추가하고 `sources/index.ts`에서 export한다.

```ts
export const SYSTEM_USER_UUID = '00000000-0000-0000-0000-000000000001';

export async function getSystemCrawlerByName(
  client: SupabaseClientType,
  name: string,
): Promise<CrawlerRow | undefined>
```

- 조회: `crawlers`에서 `user_uuid = SYSTEM_USER_UUID`이고 `name`이 같은 행 하나. `maybeSingle()`을 쓴다.
- 없으면 `undefined`. 오류면 `throw new Error(`Failed to get system crawler: ${error.message}`)`.
- 같은 파일의 다른 함수처럼 `traceDatabaseOperation`으로 감싼다(`operation: 'select'`, `table: 'crawlers'`, 속성 `db.query.name`).

## 6. crawler-manager — `executeCrawlerByName`

`CrawlerManagerWorker`에 RPC 메서드를 추가한다.

```ts
async executeCrawlerByName(name: string, input: unknown): Promise<CrawlerExecuteResult>
```

1. `name`이 문자열이 아니거나, 비었거나, 255자를 넘으면 `throw new Error('Crawler name must be a non-empty string of at most 255 characters')`.
2. `getSystemCrawlerByName`으로 찾는다. 없으면 `throw new Error(`System crawler '${name}' not found`)`.
3. 기존 `executeCrawler(codeRunnerClient, crawler, input, rpcLogger)`로 실행해 결과를 돌려준다. logger는 `executeCrawler` RPC와 같은 방식으로 만들고 metadata에 `name`을 넣는다.

- 이름으로 찾는 대상은 시스템 크롤러뿐이다. 일반 사용자의 크롤러는 이름으로 찾지 않는다.
- HTTP 라우트는 추가하지 않는다. service binding RPC로만 부른다.
- 기존 `executeCrawler(crawlerID, input)`는 그대로 둔다.

## 7. 테스트

**code runner** (`functions/crawler-code-runner-function/tests/`)
- web 타입 fetch가 §2의 헤더 3개를 그 값 그대로 보낸다. data 타입은 fetch를 부르지 않는다.
- 새 파일 `system-crawlers.test.ts`:
  - 마이그레이션 파일을 읽어 크롤러를 꺼낸다. 아래 정규식의 1번 그룹이 name, 2번 그룹을 `trim`한 것이 code다.
    ```ts
    /VALUES \('[0-9a-f-]+', '([a-z-]+)', 'web', '[^']*', \$system_crawler\$([\s\S]*?)\$system_crawler\$\);/g
    ```
  - 5개가 나오고, 각 code의 길이와 SHA-256이 §3 표와 같다. code에 ASCII가 아닌 글자가 없다.
  - 아래 `SYSTEM_CRAWLER_CASES`의 모든 항목: fetch stub이 `body`를 돌려주게 하고 `handler`에 `{ type: 'web', mode: 'run', url, code }`를 보내면 `result`가 `expected`와 같다(`toEqual`). `url`은 그 크롤러의 `url_pattern`에 맞는 아무 값이면 된다.
  - 상한:
    - `article-content`에 `'<article>' + 'a'.repeat(30000) + '</article>'`를 주면 결과 길이가 24000이다.
    - `geeknews-summary`에 `'<div class=topic_contents>' + 'b'.repeat(9000) + '</div>'`를 주면 8000이다.
    - `hn-items`에 댓글 80개(`{ author: 'u', text: 'comment N' }`)를 주면 60줄이다.

```ts
const SYSTEM_CRAWLER_CASES = [
  {
    name: 'geeknews-list',
    body:
      "<div class='topic_row' data-topic-state-id='101' data-topic-voteable='1'><div class=votenum>1</div><div class=topictitle><a href='https://example.com/posts/first' rel='nofollow' id='tr1' class='topic-title-link'><h2 class='topic-title-heading'>First &amp; <b>bold</b>  title</h2></a></div></div>\n" +
      "<div class='topic_row' data-topic-state-id='102'><div class=topictitle><a href='topic?id=102' class='topic-title-link'><h2 class='topic-title-heading'>Ask GN: second</h2></a></div></div>\n" +
      "<div class='topic_row' data-topic-state-id='103'><div class=topictitle>no heading</div></div>",
    expected: [
      { title: 'First & bold title', discussionUrl: 'https://news.hada.io/topic?id=101', originalUrl: 'https://example.com/posts/first' },
      { title: 'Ask GN: second', discussionUrl: 'https://news.hada.io/topic?id=102', originalUrl: 'https://news.hada.io/topic?id=102' },
    ],
  },
  { name: 'geeknews-list', body: 'Forbidden', expected: [] },
  {
    name: 'geeknews-summary',
    body:
      "<div class=topic_contents><div><section id='topic_contents' class='article-content'><ul>\n<li>First <strong>point</strong> &amp; more</li>\n<li>Second point</li>\n</ul></section></div><div id='comment_thread' class='comment_thread'><div class='comment'>reader comment</div></div></div>",
    expected: 'First point & more\n\nSecond point',
  },
  {
    name: 'geeknews-summary',
    body: "<div id='topic_contents'><p>Older layout</p><div class='nested'>inner</div></div><div id='comment_thread'>reader comment</div>",
    expected: 'Older layout\ninner',
  },
  { name: 'geeknews-summary', body: '<html><body>no summary here</body></html>', expected: '' },
  {
    name: 'article-content',
    body:
      '<html><head><title>x</title><style>p{}</style></head><body><nav>menu</nav><article><h1>Title</h1><p>First&nbsp;paragraph.</p><script>var a=1</script><p>Second<br>line</p></article><footer>foot</footer></body></html>',
    expected: 'Title\nFirst paragraph.\nSecond\nline',
  },
  { name: 'article-content', body: '<html><body><p>No article tag</p><aside>side</aside></body></html>', expected: 'No article tag' },
  { name: 'article-content', body: 'plain text without tags', expected: '' },
  {
    name: 'hn-search',
    body: '{"hits":[{"objectID":"1","points":5},{"objectID":"2","points":40},{"points":99}]}',
    expected: { objectID: '2', itemsUrl: 'https://hn.algolia.com/api/v1/items/2' },
  },
  { name: 'hn-search', body: '{"hits":[]}', expected: null },
  { name: 'hn-search', body: 'not json', expected: null },
  {
    name: 'hn-items',
    body:
      '{"children":[{"author":"a","text":"<p>First &amp; top</p>","children":[{"author":"b","text":"reply<br>here","children":[]}]},{"author":null,"text":"deleted"},{"author":"c","text":"second top"}]}',
    expected: 'First & top\nsecond top\nreply here',
  },
  { name: 'hn-items', body: '{"children":[]}', expected: '' },
  { name: 'hn-items', body: 'not json', expected: '' },
];
```

**connector** (`packages/supabase-connector/sources/crawlers.test.ts`에 추가, 기존 테스트 방식대로)
- `getSystemCrawlerByName`이 `user_uuid = SYSTEM_USER_UUID`와 `name`으로 조회한다.
- 행이 있으면 그 행, 없으면 `undefined`, 오류면 `Failed to get system crawler: …`를 던진다.
- `SYSTEM_USER_UUID` 값이 `'00000000-0000-0000-0000-000000000001'`이다.

**crawler-manager** (`workers/crawler-manager-worker/tests/index.test.ts`에 추가, 기존 `executeCrawler` RPC 테스트 방식대로)
- 시스템 크롤러가 있으면 code runner에 그 크롤러의 code와 입력 URL이 전달되고 결과가 돌아온다.
- 없으면 `System crawler '<name>' not found`를 던지고 code runner를 부르지 않는다.
- `name`이 빈 문자열, 256자, 문자열이 아닌 값이면 던지고 DB를 조회하지 않는다.
- 기존 `executeCrawler` 테스트가 그대로 통과한다.
