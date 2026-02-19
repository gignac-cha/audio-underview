---
file: workers/crawler-manager-worker/sources/index.ts
---
_🧹 Nitpick_ | _🔵 Trivial_

**`startsWith('/crawlers')`는 의도하지 않은 경로도 매칭할 수 있습니다.**

`/crawlersomething`과 같은 경로가 JWT 인증을 거친 후 405 응답을 반환합니다. 엄밀하게는 404가 더 적절합니다.


<details>
<summary>♻️ 경로 매칭 개선 제안</summary>

```diff
-      if (url.pathname.startsWith('/crawlers')) {
+      if (url.pathname === '/crawlers' || url.pathname.startsWith('/crawlers/')) {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@workers/crawler-manager-worker/sources/index.ts` at line 301, The route check
using url.pathname.startsWith('/crawlers') is too broad and matches unintended
paths like '/crawlersomething'; update the if condition in the index.ts branch
that checks url.pathname so it only matches the exact '/crawlers' path or
legitimate subpaths by using an equality check for '/crawlers' or a startsWith
check that requires the slash separator (i.e., startsWith '/crawlers/'); adjust
the conditional guarding the JWT-authenticated handler accordingly so unintended
routes fall through and return 404 instead of hitting the 405 branch.
```

</details>

<!-- fingerprinting:phantom:medusa:phoenix -->

<!-- This is an auto-generated comment by CodeRabbit -->
