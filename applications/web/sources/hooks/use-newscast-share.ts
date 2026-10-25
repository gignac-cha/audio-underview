/**
 * Owner-side data layer for a newscast's public share link: GET the current link
 * state, PUT to create/update it (also used for regenerate), DELETE to revoke.
 *
 * The share routes sit behind the SAME session credential as every other newscast
 * route, and a share-specific 404/409 body carries the same
 * `{ error, error_description }` shape as the rest of the API, so the requests go
 * through `newscast-request.ts` like the others.
 */

import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hasAccessToken, requestNewscastWorkerJSON } from './newscast-request.ts';
import { newscastKey } from './use-newscast-jobs.ts';

/**
 * Public metadata a share link can carry (the share row's `included_metadata`).
 *
 * `displayName` / `email` are client-supplied SNAPSHOT strings, present only
 * when the owner opted in — there is no "off" value for a string, so an
 * unpicked field is simply absent from the object, never `undefined`-valued.
 * `showModel` / `showSourceLinks` / `showCreatedAt` are booleans: the actual
 * values (provider/model/effort, source titles+links, createdAt) are resolved
 * SERVER-side from the newscast's own data, so the client only ever needs to say
 * whether each is public.
 */
export interface ShareMetadata {
  displayName?: string;
  email?: string;
  showModel?: boolean;
  showSourceLinks?: boolean;
  showCreatedAt?: boolean;
}

/** `GET /newscasts/:id/share` — no active link vs. one. */
export type ShareState =
  | { shared: false }
  | { shared: true; token: string; metadata: ShareMetadata };

/**
 * Body of `PUT /newscasts/:id/share`. `regenerate: true` swaps the token
 * (the existing link stops working immediately) while keeping the same route
 * for "just change the metadata".
 */
export interface PutShareInput {
  metadata: ShareMetadata;
  regenerate?: boolean;
}

/** 200 body of the PUT — the (possibly new) token. */
export interface PutShareResponse {
  token: string;
}

function sharePath(jobID: string): string {
  return `/newscasts/${jobID}/share`;
}

function shareQueryKey(jobID: string | undefined) {
  return [...newscastKey(jobID), 'share'] as const;
}

async function fetchShareState(jobID: string): Promise<ShareState> {
  return await requestNewscastWorkerJSON(sharePath(jobID)) as ShareState;
}

async function putShare(jobID: string, input: PutShareInput): Promise<PutShareResponse> {
  return await requestNewscastWorkerJSON(sharePath(jobID), { method: 'PUT', body: input }) as PutShareResponse;
}

async function deleteShare(jobID: string): Promise<void> {
  await requestNewscastWorkerJSON(sharePath(jobID), { method: 'DELETE' });
}

/**
 * One newscast's share link: current state plus the three owner mutations
 * (create/update, reissue, revoke). `jobID` is fixed for the hook's lifetime
 * (like `useNewscastJobDetail`) — the share dialog mounts this with the
 * SELECTED newscast's ID, so every mutation call site only needs the metadata.
 *
 * Deliberately no polling: the dialog is the only consumer and fetches fresh
 * state whenever it opens.
 *
 * Each mutation writes its own known-correct result straight into the query
 * cache (no `invalidateQueries` round trip) — a PUT's response only ever
 * carries the token, so the metadata half of the cached state is exactly what
 * was just sent, and a DELETE's result is always `{ shared: false }`.
 */
export function useNewscastShare(jobID: string | undefined) {
  const queryClient = useQueryClient();

  const query = useQuery<ShareState, Error>({
    queryKey: shareQueryKey(jobID),
    queryFn: () => fetchShareState(jobID as string),
    enabled: jobID !== undefined && hasAccessToken(),
  });

  const putMutation = useMutation<PutShareResponse, Error, PutShareInput>({
    mutationFn: (input) => putShare(jobID as string, input),
    onSuccess: (response, input) => {
      if (jobID === undefined) {
        return;
      }
      const linked: ShareState = { shared: true, token: response.token, metadata: input.metadata };
      queryClient.setQueryData<ShareState>(shareQueryKey(jobID), linked);
    },
  });

  const deleteMutation = useMutation<void, Error, void>({
    mutationFn: () => deleteShare(jobID as string),
    onSuccess: () => {
      if (jobID === undefined) {
        return;
      }
      queryClient.setQueryData<ShareState>(shareQueryKey(jobID), { shared: false });
    },
  });

  /** Create the link (no existing one) or change an existing one's metadata. */
  const createOrUpdateShare = useCallback(
    (metadata: ShareMetadata) => putMutation.mutateAsync({ metadata }),
    [putMutation],
  );

  /** Replace the token — the old link stops working the instant this resolves. */
  const reissueShare = useCallback(
    (metadata: ShareMetadata) => putMutation.mutateAsync({ metadata, regenerate: true }),
    [putMutation],
  );

  const revokeShare = useCallback(() => deleteMutation.mutateAsync(), [deleteMutation]);

  return {
    shareState: query.data,
    isLoading: query.isLoading,
    error: query.error ?? undefined,
    createOrUpdateShare,
    reissueShare,
    revokeShare,
    isSaving: putMutation.isPending,
    isRevoking: deleteMutation.isPending,
  };
}

/**
 * Absolute viewer URL for a minted token — the web assembles the share URL, so
 * the worker never learns the viewer's origin. Returns undefined when
 * `VITE_SHARE_VIEWER_URL` is not configured, so the dialog can degrade to
 * showing the bare token instead of a broken link.
 */
export function shareURLForToken(token: string): string | undefined {
  const base = import.meta.env.VITE_SHARE_VIEWER_URL;
  if (base === undefined || base.length === 0) {
    return undefined;
  }
  return `${base.replace(/\/+$/, '')}/share/${token}`;
}
