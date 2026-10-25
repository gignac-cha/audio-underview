import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  providerKeyAuditListSchema,
  providerKeyStatusListSchema,
  providerKeyStatusSchema,
  type ProviderKeyAuditEvent,
  type ProviderKeyStatus,
  type ProviderName,
} from '../schemas/provider-keys.ts';
import {
  LIST_TIMEOUT_MILLISECONDS,
  fetchCrawlerManager,
  hasAccessToken,
  parseResponseJSON,
  requestCrawlerManagerJSON,
  throwResponseError,
} from './crawler-manager-request.ts';

const PROVIDER_KEYS_QUERY_KEY = ['provider-keys'] as const;
const PROVIDER_KEY_AUDIT_QUERY_KEY = ['provider-key-audit'] as const;

function unreadableResponseError() {
  return new Error('The server sent a response this page cannot read.');
}

async function listProviderKeysRequest(): Promise<ProviderKeyStatus[]> {
  const body = await requestCrawlerManagerJSON('/provider-keys', {
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  const result = providerKeyStatusListSchema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return result.data.data;
}

/**
 * The provider keys of the account: whether each is registered, its last four characters and
 * when it was checked, never the key.
 */
export function useProviderKeys() {
  const query = useQuery<ProviderKeyStatus[], Error>({
    queryKey: PROVIDER_KEYS_QUERY_KEY,
    queryFn: listProviderKeysRequest,
    enabled: hasAccessToken(),
  });

  return {
    providerKeys: query.data ?? [],
    isLoading: query.isLoading,
    isLoaded: query.isSuccess,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}

async function listProviderKeyAuditRequest(): Promise<ProviderKeyAuditEvent[]> {
  const body = await requestCrawlerManagerJSON('/provider-keys/audit', {
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  const result = providerKeyAuditListSchema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return result.data.data;
}

/**
 * The recent history of the provider keys, newest first.
 */
export function useProviderKeyAudit() {
  const query = useQuery<ProviderKeyAuditEvent[], Error>({
    queryKey: PROVIDER_KEY_AUDIT_QUERY_KEY,
    queryFn: listProviderKeyAuditRequest,
    enabled: hasAccessToken(),
  });

  return {
    events: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}

interface SetProviderKeyInput {
  provider: ProviderName;
  key: string;
}

async function setProviderKeyRequest(input: SetProviderKeyInput): Promise<ProviderKeyStatus> {
  const response = await fetchCrawlerManager(`/provider-keys/${encodeURIComponent(input.provider)}`, {
    method: 'PUT',
    body: { key: input.key },
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  const body = await parseResponseJSON(response);
  if (!response.ok) {
    throwResponseError(body, response.status);
  }
  const result = providerKeyStatusSchema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return result.data;
}

/**
 * Registers the key of a provider, or replaces the one it has. The server checks the key with
 * the provider before it stores it.
 *
 * Not a TanStack mutation on purpose, for the same reason as useSetEnvironmentVariable: a
 * mutation keeps its variables in the MutationCache after it settles, which would keep the key
 * in page memory. The key lives only in the arguments of this call. What is kept is the names of
 * the providers whose request is still on its way, so that each row knows its own state.
 */
export function useSetProviderKey() {
  const queryClient = useQueryClient();
  const [pendingProviders, setPendingProviders] = useState<ProviderName[]>([]);

  const setProviderKey = async (input: SetProviderKeyInput): Promise<ProviderKeyStatus> => {
    const { provider } = input;
    setPendingProviders((previous) => [...previous, provider]);
    try {
      return await setProviderKeyRequest(input);
    } finally {
      setPendingProviders((previous) => previous.filter((pending) => pending !== provider));
      // Also after a failure: a request that timed out or lost its answer may have stored the key
      queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PROVIDER_KEY_AUDIT_QUERY_KEY });
    }
  };

  return { setProviderKey, pendingProviders };
}

async function deleteProviderKeyRequest(provider: ProviderName): Promise<void> {
  await requestCrawlerManagerJSON(`/provider-keys/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
}

export function useDeleteProviderKey() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, ProviderName>({
    mutationFn: deleteProviderKeyRequest,
    // Settled, so that a key that was already gone leaves the list as well
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PROVIDER_KEYS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PROVIDER_KEY_AUDIT_QUERY_KEY });
    },
  });

  return {
    deleteProviderKey: mutation.mutateAsync,
    // The provider is not a secret, so the mutation may keep it
    deletingProvider: mutation.isPending ? mutation.variables : undefined,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}
