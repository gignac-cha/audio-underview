import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  environmentVariableListSchema,
  environmentVariableSummarySchema,
  type EnvironmentVariableSummary,
} from '../schemas/crawler-runs.ts';
import {
  LIST_TIMEOUT_MILLISECONDS,
  fetchCrawlerManager,
  hasAccessToken,
  parseResponseJSON,
  requestCrawlerManagerJSON,
  throwResponseError,
} from './crawler-manager-request.ts';

const ENVIRONMENT_VARIABLES_QUERY_KEY = ['environment-variables'] as const;

function unreadableResponseError() {
  return new Error('The server sent a response this page cannot read.');
}

async function listEnvironmentVariablesRequest(): Promise<EnvironmentVariableSummary[]> {
  const body = await requestCrawlerManagerJSON('/environment-variables', {
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  const result = environmentVariableListSchema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return result.data.data;
}

interface ListEnvironmentVariablesOptions {
  // False while the page has no use for the list, so that it is not requested
  enabled?: boolean;
}

/**
 * The environment variables of the account: names and times, never values.
 */
export function useListEnvironmentVariables({ enabled = true }: ListEnvironmentVariablesOptions = {}) {
  const query = useQuery<EnvironmentVariableSummary[], Error>({
    queryKey: ENVIRONMENT_VARIABLES_QUERY_KEY,
    queryFn: listEnvironmentVariablesRequest,
    enabled: enabled && hasAccessToken(),
  });

  return {
    environmentVariables: query.data ?? [],
    isLoading: query.isLoading,
    isLoaded: query.isSuccess,
    error: query.error ?? undefined,
    refetch: query.refetch,
  };
}

interface SetEnvironmentVariableInput {
  name: string;
  value: string;
}

interface SetEnvironmentVariableResult {
  variable: EnvironmentVariableSummary;
  // True when the name existed already and the server replaced its value (200 instead of 201)
  replaced: boolean;
}

async function setEnvironmentVariableRequest(input: SetEnvironmentVariableInput): Promise<SetEnvironmentVariableResult> {
  const response = await fetchCrawlerManager(`/environment-variables/${encodeURIComponent(input.name)}`, {
    method: 'PUT',
    body: { value: input.value },
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
  const body = await parseResponseJSON(response);
  if (!response.ok) {
    throwResponseError(body, response.status);
  }
  const result = environmentVariableSummarySchema.safeParse(body);
  if (!result.success) {
    throw unreadableResponseError();
  }
  return { variable: result.data, replaced: response.status === 200 };
}

type SetEnvironmentVariableStatus = 'idle' | 'pending' | 'success' | 'error';

/**
 * Creates the variable, or replaces its value when the name exists.
 *
 * Not a TanStack mutation on purpose: a mutation keeps its variables in the MutationCache (and in
 * its own state) after it settles, which would keep the secret value in page memory. The value
 * lives only in the arguments of this call, so nothing here holds it once the request is sent.
 */
export function useSetEnvironmentVariable() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SetEnvironmentVariableStatus>('idle');
  const [error, setError] = useState<Error>();

  const setEnvironmentVariable = async (input: SetEnvironmentVariableInput): Promise<SetEnvironmentVariableResult> => {
    setStatus('pending');
    setError(undefined);
    try {
      const result = await setEnvironmentVariableRequest(input);
      setStatus('success');
      queryClient.invalidateQueries({ queryKey: ENVIRONMENT_VARIABLES_QUERY_KEY });
      return result;
    } catch (requestError) {
      const failure = requestError instanceof Error ? requestError : new Error(String(requestError));
      setStatus('error');
      setError(failure);
      throw failure;
    }
  };

  const reset = () => {
    setStatus('idle');
    setError(undefined);
  };

  return { setEnvironmentVariable, status, error, reset };
}

async function deleteEnvironmentVariableRequest(name: string): Promise<void> {
  await requestCrawlerManagerJSON(`/environment-variables/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    timeoutMilliseconds: LIST_TIMEOUT_MILLISECONDS,
  });
}

export function useDeleteEnvironmentVariable() {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, string>({
    mutationFn: deleteEnvironmentVariableRequest,
    // Settled, so that a variable that was already gone leaves the list as well
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ENVIRONMENT_VARIABLES_QUERY_KEY });
    },
  });

  return {
    deleteEnvironmentVariable: mutation.mutateAsync,
    status: mutation.status,
    error: mutation.error ?? undefined,
    reset: mutation.reset,
  };
}
