---
file: workers/crawler-manager-worker/tests/index.test.ts
---
_🧹 Nitpick_ | _🔵 Trivial_

**`mockSupabaseCrawlerList`에 빈 배열 전달 시 잘못된 `content-range` 헤더 생성 가능.**

`data`가 빈 배열(`[]`)일 경우 `content-range` 헤더가 `0--1/0`으로 생성되어 유효하지 않은 형식이 됩니다. 현재 테스트에서 빈 배열로 호출하는 경우는 없지만, 향후 테스트 추가 시 혼란을 줄 수 있습니다.



<details>
<summary>♻️ 빈 배열 케이스 방어 코드 제안</summary>

```diff
 function mockSupabaseCrawlerList(data: unknown[] = [mockCrawlerResponse()], total: number = 1) {
+  const rangeEnd = data.length > 0 ? data.length - 1 : 0;
+  const rangeHeader = data.length > 0 ? `0-${rangeEnd}/${total}` : `*/${total}`;
   fetchMock
     .get('https://supabase.example.com')
     .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
-    .reply(200, JSON.stringify(data), { headers: { 'content-range': `0-${data.length - 1}/${total}` } });
+    .reply(200, JSON.stringify(data), { headers: { 'content-range': rangeHeader } });
 }
```
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
function mockSupabaseCrawlerList(data: unknown[] = [mockCrawlerResponse()], total: number = 1) {
  const rangeEnd = data.length > 0 ? data.length - 1 : 0;
  const rangeHeader = data.length > 0 ? `0-${rangeEnd}/${total}` : `*/${total}`;
  fetchMock
    .get('https://supabase.example.com')
    .intercept({ path: /^\/rest\/v1\/crawlers/, method: 'GET' })
    .reply(200, JSON.stringify(data), { headers: { 'content-range': rangeHeader } });
}
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@workers/crawler-manager-worker/tests/index.test.ts` around lines 48 - 53, The
helper mockSupabaseCrawlerList builds an invalid content-range when data is an
empty array (it produces "0--1/0"); update mockSupabaseCrawlerList to compute
the content-range safely by using total and data.length: when data.length is 0
set the range portion to "0-0/0" or otherwise use `0-${data.length -
1}/${total}` so the header is always a valid content-range; modify the logic
inside mockSupabaseCrawlerList where the headers are created to handle the
empty-array case and produce a well-formed header.
```

</details>

<!-- fingerprinting:phantom:medusa:phoenix -->

<!-- This is an auto-generated comment by CodeRabbit -->
