/**
 * Serving one stored audio object from R2, with byte ranges, for both audio routes:
 * the owner's `GET /newscasts/:id/audio` and the public `GET /share/:token/audio`.
 * Which key is served is `audio-lookup.ts`'s mapping.
 *
 * Byte ranges are advertised and honoured so the browser can SEEK: without them a
 * media element cannot jump to an un-buffered position (clicking a caption just
 * snapped playback back to 0).
 */

/**
 * How a stored-audio response's base headers are built. The owner route derives
 * them from `ALLOWED_ORIGINS`; the public share route answers
 * `Access-Control-Allow-Origin: *` instead, because a share link carries no
 * credential at all. Passing the factory in is what lets ONE copy of the R2/Range
 * serving logic answer both.
 */
export type AudioHeadersFactory = () => Headers;

/**
 * Serve one R2 audio object, or `null` when it is absent (the caller decides what
 * "missing" means — the owner route says "not ready yet", the share route says
 * 404 like an unknown token). `.head` yields size + `httpMetadata.contentType`
 * without pulling the body, so a Range request fetches only the requested slice
 * (streamed as a 206). A rare head/get race also returns `null`.
 */
export async function serveR2Audio(
  bucket: R2Bucket,
  buildHeaders: AudioHeadersFactory,
  key: string,
  rangeHeader: string | null,
): Promise<Response | null> {
  const head = await bucket.head(key);
  if (head === null) {
    return null;
  }
  const headers = buildHeaders();
  headers.set('Content-Type', head.httpMetadata?.contentType ?? 'audio/mpeg');
  headers.set('Accept-Ranges', 'bytes');
  const totalLength = head.size;

  const range = parseByteRange(rangeHeader, totalLength);
  if (range !== undefined) {
    const partial = await bucket.get(key, {
      range: { offset: range.start, length: range.end - range.start + 1 },
    });
    if (partial !== null) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${totalLength}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      return new Response(partial.body, { status: 206, headers });
    }
  }

  const object = await bucket.get(key);
  if (object !== null) {
    headers.set('Content-Length', String(totalLength));
    return new Response(object.body, { status: 200, headers });
  }
  // Object vanished between head and get (rare race) — treat as a miss.
  return null;
}

/**
 * Parse a single `Range: bytes=start-end` header into inclusive byte offsets,
 * or `undefined` when the header is absent/unsatisfiable (caller then serves the
 * full body). Supports open-ended (`bytes=500-`) and suffix (`bytes=-1000`) forms.
 */
export function parseByteRange(
  header: string | null,
  totalLength: number,
): { start: number; end: number } | undefined {
  if (header === null) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return undefined;
  }
  const [, startText, endText] = match;
  let start: number;
  let end: number;
  if (startText === '') {
    if (endText === '') {
      return undefined;
    }
    const suffix = Number(endText);
    if (suffix <= 0) {
      return undefined;
    }
    start = Math.max(0, totalLength - suffix);
    end = totalLength - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? totalLength - 1 : Number(endText);
  }
  end = Math.min(end, totalLength - 1);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= totalLength) {
    return undefined;
  }
  return { start, end };
}
