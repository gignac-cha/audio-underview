import { useQuery } from '@tanstack/react-query';
import { loadAuthenticationData, type OAuthProviderID, type OAuthUser } from '@audio-underview/sign-provider';
import { linkedAccountsResponseSchema, type LinkedAccount } from '../schemas/linked-accounts.ts';

const REQUEST_TIMEOUT_MILLISECONDS = 30_000;

function presentOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The OAuth worker that signed the user in, which also serves `/accounts`.
 * Only Google and GitHub have workers today; any other provider has none.
 */
export function accountsWorkerURL(provider: OAuthProviderID): string | undefined {
  switch (provider) {
    case 'google':
      return presentOrUndefined(import.meta.env.VITE_GOOGLE_OAUTH_WORKER_URL);
    case 'github':
      return presentOrUndefined(import.meta.env.VITE_GITHUB_OAUTH_WORKER_URL);
    default:
      return undefined;
  }
}

/**
 * A 401 is an expected answer (the session is over), not a failure to retry,
 * so it resolves as data instead of throwing. Everything else that goes wrong
 * throws and follows the query client's retry setting.
 */
type LinkedAccountsResult =
  | { outcome: 'listed'; accounts: readonly LinkedAccount[] }
  | { outcome: 'unauthorized' };

async function requestLinkedAccounts(workerURL: string): Promise<LinkedAccountsResult> {
  const authenticationData = loadAuthenticationData();
  if (authenticationData === null) {
    // No stored session means the worker would answer 401; skip the round trip.
    return { outcome: 'unauthorized' };
  }

  const response = await fetch(new URL('/accounts', workerURL), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${authenticationData.credential}`,
    },
    // Only a timeout: taking the query's cancel signal would abort and resend the
    // request when React StrictMode remounts the page.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
  });

  if (response.status === 401) {
    return { outcome: 'unauthorized' };
  }

  if (!response.ok) {
    throw new Error(`Listing linked accounts failed with status ${response.status}`);
  }

  const body: unknown = await response.json();
  const { accounts } = linkedAccountsResponseSchema.parse(body);
  return { outcome: 'listed', accounts };
}

export type LinkedAccountsState =
  | { status: 'loading' }
  | { status: 'listed'; accounts: readonly LinkedAccount[] }
  | { status: 'unauthorized' }
  | { status: 'failed' };

export interface UseLinkedAccountsResult {
  state: LinkedAccountsState;
  /** Requests the list again. Does nothing when no worker URL is configured. */
  retry: () => void;
}

/**
 * Lists the logins linked to the signed-in account from the worker of the
 * provider the user signed in with, authenticated by the stored credential.
 */
export function useLinkedAccounts(user: OAuthUser | undefined): UseLinkedAccountsResult {
  const workerURL = user === undefined ? undefined : accountsWorkerURL(user.provider);

  const query = useQuery({
    queryKey: ['linked-accounts', user?.provider, user?.id, workerURL],
    queryFn: () => {
      if (workerURL === undefined) {
        throw new Error('The OAuth worker URL for this provider is not configured');
      }
      return requestLinkedAccounts(workerURL);
    },
    enabled: workerURL !== undefined,
  });

  const retry = () => {
    if (workerURL !== undefined) {
      void query.refetch();
    }
  };

  return { state: deriveState(workerURL, query), retry };
}

function deriveState(
  workerURL: string | undefined,
  query: { data: LinkedAccountsResult | undefined; isError: boolean; isFetching: boolean },
): LinkedAccountsState {
  if (workerURL === undefined) {
    return { status: 'failed' };
  }

  if (query.data !== undefined) {
    return query.data.outcome === 'unauthorized'
      ? { status: 'unauthorized' }
      : { status: 'listed', accounts: query.data.accounts };
  }

  if (query.isError && !query.isFetching) {
    return { status: 'failed' };
  }

  return { status: 'loading' };
}
