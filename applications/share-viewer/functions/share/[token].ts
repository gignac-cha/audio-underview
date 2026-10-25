/**
 * Server-side Open Graph injection for `/share/:token`.
 *
 * Messenger scrapers (KakaoTalk, Slack, Discord) never execute the bundle, so
 * the head has to be correct in the FIRST response. This Function fetches the
 * public share payload, rewrites the static `index.html` head with HTMLRewriter,
 * and hands the same HTML to both scrapers and readers — the SPA then boots and
 * fetches the payload itself for rendering.
 *
 * A missing or revoked link is served as the same static HTML with HTTP 404:
 * the router shows the "no longer valid" screen, and the status code keeps the
 * link honest to crawlers.
 *
 * Known limitation (accepted, design §5.5): messengers cache preview cards, so a
 * revoked link may keep showing its old card for a while even though opening it
 * now 404s.
 */

import {
  buildFallbackOpenGraphMetadata,
  buildShareOpenGraphMetadata,
  renderOpenGraphTags,
  type OpenGraphMetadata,
  type ShareOpenGraphSource,
} from '../../sources/open-graph/share-metadata.ts';
import { NEWSCAST_WORKER_URL } from '../worker-url.generated.ts';

/** How long to wait on the worker before falling back to a generic head. */
const WORKER_TIMEOUT_MILLISECONDS = 4000;

function shareEndpoint(workerOrigin: string, token: string): string {
  return `${workerOrigin.replace(/\/+$/, '')}/share/${encodeURIComponent(token)}`;
}

/** First part's MP3 on the worker origin — the value `og:audio` declares. */
function shareAudioEndpoint(workerOrigin: string, token: string): string {
  return `${shareEndpoint(workerOrigin, token)}/audio?part=1`;
}

/**
 * `null` means "render the invalid-link page": either the worker said 404, or
 * it could not be reached at all. A scraper must not be able to tell those
 * apart, and a reader gets the same screen either way.
 */
async function loadShareSource(token: string): Promise<ShareOpenGraphSource | null> {
  if (NEWSCAST_WORKER_URL === '') {
    return null;
  }
  try {
    const response = await fetch(shareEndpoint(NEWSCAST_WORKER_URL, token), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ShareOpenGraphSource;
  } catch {
    return null;
  }
}

function injectHead(
  documentResponse: Response,
  metadata: OpenGraphMetadata,
  status: number,
): Response {
  const rewritten = new HTMLRewriter()
    .on('title', {
      element(element) {
        // Text mode (the default) — HTMLRewriter escapes it, so a newscast
        // title containing markup cannot close the tag early.
        element.setInnerContent(metadata.documentTitle);
      },
    })
    .on('head', {
      element(element) {
        element.append(renderOpenGraphTags(metadata), { html: true });
      },
    })
    .transform(documentResponse);

  const headers = new Headers(rewritten.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  // The card content mirrors a live, revocable job — never let an intermediary
  // keep serving it after the link is pulled.
  headers.set('cache-control', 'no-store');
  headers.set('x-robots-tag', 'noindex');

  return new Response(rewritten.body, { status, headers });
}

/**
 * Pages supplies the `ASSETS` binding on top of the environment type — see
 * `PagesFunction`'s own `Env & { ASSETS }` intersection. The worker origin is
 * not an environment variable (see `worker-url.generated.ts`).
 */
export const onRequestGet: PagesFunction<unknown, 'token'> = async (context) => {
  const rawToken = context.params.token;
  const token = Array.isArray(rawToken) ? (rawToken[0] ?? '') : (rawToken ?? '');

  const requestUrl = context.request.url;
  const documentRequest = new Request(new URL('/index.html', requestUrl).toString(), {
    headers: { accept: 'text/html' },
  });
  const documentResponse = await context.env.ASSETS.fetch(documentRequest);

  const source = token === '' ? null : await loadShareSource(token);
  if (source === null) {
    return injectHead(documentResponse, buildFallbackOpenGraphMetadata(requestUrl), 404);
  }

  return injectHead(
    documentResponse,
    buildShareOpenGraphMetadata(source, requestUrl, {
      audioUrl: shareAudioEndpoint(NEWSCAST_WORKER_URL, token),
    }),
    200,
  );
};
