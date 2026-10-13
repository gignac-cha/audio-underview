import { z } from 'zod';
import { oauthProviderID } from '@audio-underview/sign-provider';

/**
 * One login linked to the signed-in account, as returned by
 * `GET <OAuth worker URL>/accounts`. `linkedAt` is an ISO 8601 timestamp, or
 * `null` when the worker does not know when the login was linked.
 */
export const linkedAccountSchema = z.object({
  provider: oauthProviderID,
  linkedAt: z.iso.datetime({ offset: true }).nullable(),
});

/** The 200 response body of `GET <OAuth worker URL>/accounts`. */
export const linkedAccountsResponseSchema = z.object({
  accounts: z.array(linkedAccountSchema),
});

export type LinkedAccount = z.infer<typeof linkedAccountSchema>;

export type LinkedAccountsResponse = z.infer<typeof linkedAccountsResponseSchema>;
