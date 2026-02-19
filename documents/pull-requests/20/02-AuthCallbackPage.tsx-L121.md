---
file: applications/web/sources/pages/AuthCallbackPage.tsx
---
_⚠️ Potential issue_ | _🔴 Critical_

**토큰 교환 응답에 대한 런타임 유효성 검증이 없습니다 — NaN 전파로 세션이 만료되지 않을 수 있습니다.**

Line 121의 `as` 캐스트는 런타임 타입 안전성을 보장하지 않습니다. 서버가 예상과 다른 응답을 반환할 경우:

- `tokenData.expires_in`이 `undefined`이면 → `undefined * 1000` = `NaN` → `NaN ?? sessionDuration` = `NaN` (NaN은 nullish가 아님) → `expiresAt = Date.now() + NaN` = `NaN` → `NaN < Date.now()`는 `false`이므로 **세션이 영구적으로 만료되지 않습니다**.
- `tokenData.token`이 `undefined`이면 → 유효하지 않은 인증 정보가 저장됩니다.


<details>
<summary>🛡️ 런타임 유효성 검증 추가 제안</summary>

```diff
-        const tokenData = await tokenResponse.json() as { token: string; expires_in: number };
+        const tokenData = await tokenResponse.json() as Record<string, unknown>;
+
+        if (typeof tokenData.token !== 'string' || typeof tokenData.expires_in !== 'number') {
+          throw new Error('Invalid token exchange response format');
+        }

         // Login with the JWT (not the OAuth access token)
-        const result = loginWithProvider(user.provider, user, tokenData.token, tokenData.expires_in * 1000);
+        const result = loginWithProvider(user.provider, user, tokenData.token, (tokenData.expires_in as number) * 1000);
```

또는 Zod 스키마를 사용하여 일관된 검증 패턴을 적용할 수 있습니다:

```typescript
const tokenExchangeResponseSchema = z.object({
  token: z.string().min(1),
  expires_in: z.number().positive(),
});
const tokenData = tokenExchangeResponseSchema.parse(await tokenResponse.json());
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@applications/web/sources/pages/AuthCallbackPage.tsx` around lines 121 - 124,
The token exchange response is being blindly cast to { token: string;
expires_in: number } which can produce NaN or undefined values; add runtime
validation of tokenResponse.json() before calling loginWithProvider: verify
token is a non-empty string and expires_in is a finite positive number (use a
small validator or a Zod schema like tokenExchangeResponseSchema) and if
validation fails either throw/return an error or fallback to a safe expires_in
(e.g., sessionDuration) while ensuring you never call
loginWithProvider(user.provider, user, token, expiresMs) with an invalid token
or NaN expiry; also guard the computed expiry (expires_in * 1000) against NaN
using Number.isFinite and apply the fallback.
```

</details>

<!-- fingerprinting:phantom:medusa:phoenix -->

<!-- This is an auto-generated comment by CodeRabbit -->
