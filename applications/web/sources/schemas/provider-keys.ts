import { z } from 'zod';

/**
 * The provider keys of the account, as the crawler manager answers them: whether a key is
 * registered, its last four characters and when the provider last accepted it. A key itself
 * never comes back.
 */

// The order of the vault, which is also the order of the rows on the page
export const PROVIDER_NAMES = ['anthropic', 'openai', 'google', 'xai'] as const;

export const providerNameSchema = z.enum(PROVIDER_NAMES);

export type ProviderName = z.infer<typeof providerNameSchema>;

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI (Grok)',
};

/** One row of `GET /provider-keys`, and the 200 body of `PUT /provider-keys/:provider`. */
export const providerKeyStatusSchema = z.object({
  provider: providerNameSchema,
  configured: z.boolean(),
  last4: z.string().nullable(),
  validated_at: z.string().nullable(),
});

export type ProviderKeyStatus = z.infer<typeof providerKeyStatusSchema>;

export const providerKeyStatusListSchema = z.object({
  data: z.array(providerKeyStatusSchema),
});

export const PROVIDER_KEY_AUDIT_ACTIONS = ['registered', 'replaced', 'removed', 'used'] as const;

export type ProviderKeyAuditAction = (typeof PROVIDER_KEY_AUDIT_ACTIONS)[number];

/** One row of `GET /provider-keys/audit`, newest first. */
export const providerKeyAuditEventSchema = z.object({
  provider: providerNameSchema,
  action: z.enum(PROVIDER_KEY_AUDIT_ACTIONS),
  at: z.string(),
});

export type ProviderKeyAuditEvent = z.infer<typeof providerKeyAuditEventSchema>;

export const providerKeyAuditListSchema = z.object({
  data: z.array(providerKeyAuditEventSchema),
});

/**
 * The rule the crawler manager and the vault apply to a key, checked here first so that a
 * mistake shows next to the input instead of coming back as a failed request.
 */

export const PROVIDER_KEY_MINIMUM_LENGTH = 16;
export const PROVIDER_KEY_MAXIMUM_LENGTH = 512;

// Printable ASCII without the space (0x21 to 0x7E)
const PROVIDER_KEY_PATTERN = /^[\x21-\x7e]+$/;

export function validateProviderKey(key: string): string | undefined {
  if (key.length < PROVIDER_KEY_MINIMUM_LENGTH || key.length > PROVIDER_KEY_MAXIMUM_LENGTH || !PROVIDER_KEY_PATTERN.test(key)) {
    return `A key must be ${PROVIDER_KEY_MINIMUM_LENGTH} to ${PROVIDER_KEY_MAXIMUM_LENGTH} printable characters without spaces.`;
  }
  return undefined;
}
