/**
 * Pure key-mapping for the audio routes (`GET /newscasts/:id/audio` and
 * `GET /share/:token/audio`). Kept in its own module — free of the
 * `cloudflare:workers` runtime graph — so the R2 key formats and the `?part=N`
 * mapping (contracts shared with the web player, design §7-6) are unit-testable
 * without any I/O.
 */

/**
 * Defensive upper bound on the `?part=N` audio query. Well above the 3-part
 * newscast ceiling (design §2) so a legitimate part is never rejected while an
 * absurd value still 400s instead of minting a wild R2 key lookup.
 */
export const MAX_AUDIO_PART_INDEX = 10;

/**
 * The R2 key `GET .../audio` serves, or `invalid` for a bad `?part`. A miss on
 * the key is 404.
 */
export type AudioLookup = { valid: false } | { valid: true; key: string };

/**
 * Resolve which stored-audio key to look up from the newscast id and the optional
 * `?part=N` query (design §7-6).
 *
 * - `?part=signal` targets the per-newscast transition sting, `${id}/signal`
 *   (design §15). Checked BEFORE the integer validation so the literal `signal`
 *   keyword is never treated as a bad number.
 * - A valid `?part=N` (positive integer, 1..{@link MAX_AUDIO_PART_INDEX}) targets
 *   `${id}/part-${N}`.
 * - A `?part` that is not a positive integer in range is a client error (400).
 * - No `?part` plays part 1, `${id}/part-1`. Every newscast of this worker stores
 *   its audio as parts, so there is no older bare-id key to fall back to.
 */
export function resolveAudioLookup(id: string, partParam: string | null): AudioLookup {
  if (partParam === null) {
    return { valid: true, key: `${id}/part-1` };
  }
  if (partParam === 'signal') {
    return { valid: true, key: `${id}/signal` };
  }
  if (!/^\d+$/.test(partParam)) {
    return { valid: false };
  }
  const part = Number(partParam);
  if (!Number.isInteger(part) || part < 1 || part > MAX_AUDIO_PART_INDEX) {
    return { valid: false };
  }
  return { valid: true, key: `${id}/part-${part}` };
}
