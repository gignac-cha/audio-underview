/**
 * Whether a text is an http or https URL. These are the only addresses the newscast screens link to:
 * a source URL comes from a crawled page or from what a user typed, so any other address (javascript:,
 * data:) is shown as text and never put in an href.
 */
export function isHTTPURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
