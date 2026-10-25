/**
 * Loads one shared newscast. Three terminal states, because that is exactly
 * what the viewer renders: a skeleton, the newscast, or the "link is no longer
 * valid" screen. A transport failure is kept separate from a 404 so a flaky
 * network is not reported to the reader as a revoked link.
 */

import { useEffect, useState } from 'react';
import type { PublicShareView } from '../schemas/public-share-view.ts';
import { ShareNotFoundError, fetchShareView, newscastWorkerOrigin } from './share-api.ts';

/**
 * With no worker configured there is nothing to fetch, so `pnpm dev` shows the
 * fixture instead of an error screen — the viewer was built before the worker's
 * `/share/:token` route existed.
 *
 * Both guards matter. `import.meta.env.DEV` is statically false in a production
 * build, so the dynamic import below is dropped from the bundle entirely; the
 * empty-origin check means that even in dev, a configured worker is always used.
 */
async function loadShareView(token: string): Promise<PublicShareView> {
  if (import.meta.env.DEV && newscastWorkerOrigin() === '') {
    const { SAMPLE_SHARE_VIEW } = await import('../fixtures/sample-share-view.ts');
    return SAMPLE_SHARE_VIEW;
  }
  return fetchShareView(token);
}

export type ShareViewState =
  | { status: 'loading' }
  | { status: 'ready'; view: PublicShareView }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export function useShareView(token: string | undefined): ShareViewState {
  const [state, setState] = useState<ShareViewState>({ status: 'loading' });

  useEffect(() => {
    if (token === undefined || token === '') {
      setState({ status: 'not-found' });
      return;
    }
    // Guards against a late response from a previous token overwriting the
    // current one (a reader following two links in one session).
    let cancelled = false;
    setState({ status: 'loading' });
    loadShareView(token)
      .then((view) => {
        if (!cancelled) {
          setState({ status: 'ready', view });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ShareNotFoundError) {
          setState({ status: 'not-found' });
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return state;
}
