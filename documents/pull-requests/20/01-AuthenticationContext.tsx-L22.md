---
file: applications/web/sources/contexts/AuthenticationContext.tsx
---
_⚠️ Potential issue_ | _🟠 Major_

**사용자 이메일(PII)이 로그에 기록됩니다.**

Line 116에서 `userData.email`을 로그에 포함하고 있습니다. 이메일은 개인식별정보(PII)이므로 GDPR/CCPA 관점에서 로그에 기록하면 안 됩니다. 로그에서 제거하거나 마스킹 처리가 필요합니다.


<details>
<summary>🛡️ 이메일 제거 제안</summary>

```diff
       authenticationLogger.info('Logging in with provider', {
         providerID,
         userID: userData.id,
-        email: userData.email,
       }, { function: 'loginWithProvider' });
```
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
      authenticationLogger.info('Logging in with provider', {
        providerID,
        userID: userData.id,
      }, { function: 'loginWithProvider' });
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against the current code and only fix it if needed.

In `@applications/web/sources/contexts/AuthenticationContext.tsx` around lines 113
- 117, The log call in AuthenticationContext.tsx inside the loginWithProvider
flow currently includes userData.email (PII); remove the raw email from the
authenticationLogger.info payload and either omit it or replace it with a
non-PII placeholder (e.g., maskedEmail produced by a masking utility or a
boolean/enum like hasEmail) so logs do not contain plaintext emails; update the
authenticationLogger.info invocation (the call that passes providerID, userID,
email, and { function: 'loginWithProvider' }) to use only non-PII fields
(providerID, userID) or a maskedEmail value obtained via a maskEmail helper
function.
```

</details>

<!-- fingerprinting:phantom:medusa:phoenix -->

<!-- This is an auto-generated comment by CodeRabbit -->
