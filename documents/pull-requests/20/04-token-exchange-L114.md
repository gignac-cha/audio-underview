---
file: workers/crawler-manager-worker/sources/token-exchange.ts
---
_⚠️ Potential issue_ | _🟡 Minor_

**JSON `null` 본문이 TypeError를 발생시킬 수 있습니다.**

`request.json()`이 유효한 JSON인 `null`을 반환하면, Line 108의 `body.provider` 접근 시 `TypeError: Cannot read properties of null`이 발생합니다. 이 예외는 내부 try/catch(Line 102-106) 범위 밖에 있어 호출측의 외부 try/catch(index.ts)에서 500 에러로 처리됩니다.


<details>
<summary>🛡️ null 체크 추가 제안</summary>

```diff
   let body: TokenExchangeRequestBody;
   try {
     body = await request.json() as TokenExchangeRequestBody;
   } catch {
     return errorResponse('invalid_request', 'Request body must be valid JSON', 400, context);
   }

+  if (!body || typeof body !== 'object') {
+    return errorResponse('invalid_request', 'Request body must be a JSON object', 400, context);
+  }
+
   if (!body.provider || !['google', 'github'].includes(body.provider)) {
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@workers/crawler-manager-worker/sources/token-exchange.ts` around lines 101 -
114, The code currently assumes request.json() returns an object and will throw
a TypeError if it returns null; after parsing body = await request.json() in
token-exchange.ts, add an explicit null check (e.g., if (body === null) return
errorResponse('invalid_request', 'Request body must be a non-null JSON object',
400, context)) before accessing body.provider or body.access_token so downstream
checks against body.provider and typeof body.access_token are safe; keep using
the existing errorResponse helper and the same allowed provider list check for
'google' and 'github'.
```

</details>

<!-- fingerprinting:phantom:medusa:phoenix -->

<!-- This is an auto-generated comment by CodeRabbit -->
