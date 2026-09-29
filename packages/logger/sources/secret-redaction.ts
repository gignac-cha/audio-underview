/**
 * Credential redaction for free-form text (log values, provider error messages).
 *
 * This module intentionally has no imports so that the logger and any worker
 * can use it without pulling in other dependencies.
 */

/** Characters that may appear in the body of a credential, including masking characters. */
const CREDENTIAL_BODY = '[A-Za-z0-9_*•-]';

interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

/**
 * Redaction rules, applied in this exact order.
 */
const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: new RegExp(String.raw`Bearer\s+[A-Za-z0-9._~+/=*•-]{4,}`, 'gi'),
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bsk([-_])${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'sk$1[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bAIza${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'AIza[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\b([AI]Q)\.[A-Za-z0-9._*•-]{4,}`, 'g'),
    replacement: '$1.[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bxai-${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'xai-[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bgsk_${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'gsk_[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bya29\.[A-Za-z0-9._*•-]{4,}`, 'g'),
    replacement: 'ya29.[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bgh[opusr]_${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'gh_[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+`, 'g'),
    replacement: 'eyJ[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\borg-${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'org-[REDACTED]',
  },
  {
    pattern: new RegExp(String.raw`\bproj_${CREDENTIAL_BODY}{4,}`, 'g'),
    replacement: 'proj_[REDACTED]',
  },
];

/** Default maximum length for text that came from an AI model provider. */
export const PROVIDER_TEXT_MAXIMUM_LENGTH = 200;

const TRUNCATION_MARKER = '… [truncated]';

/**
 * Replace every credential-looking token in the text with a `[REDACTED]` marker.
 */
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const rule of REDACTION_RULES) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
}

/**
 * Return the text unchanged when it fits, otherwise its first `maximumLength`
 * characters followed by a truncation marker.
 */
export function truncateText(text: string, maximumLength = PROVIDER_TEXT_MAXIMUM_LENGTH): string {
  if (text.length <= maximumLength) {
    return text;
  }
  return `${text.slice(0, maximumLength)}${TRUNCATION_MARKER}`;
}

/**
 * Redact first, then truncate, so that a cut never leaves a partial credential behind.
 */
export function redactAndTruncate(text: string, maximumLength = PROVIDER_TEXT_MAXIMUM_LENGTH): string {
  return truncateText(redactSecrets(text), maximumLength);
}
