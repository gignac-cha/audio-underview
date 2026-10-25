/**
 * A hand-written `PublicShareView` matching the §4.1 example in the design doc.
 *
 * It exists because the viewer ships before the worker's `/share/:token` route
 * does: `pnpm dev` renders this when the worker is unreachable, and every test
 * in this package drives the real components off it instead of a live fetch.
 * Deliberately exercises the awkward cases — two parts, a part whose last line
 * has NO word timings, a between-parts sting, and every metadata flag on.
 */

import samplePayload from './sample-share-view.json';
import type { PublicShareView } from '../schemas/public-share-view.ts';

/**
 * The double assertion is the honest one: this is an untyped wire payload, and
 * TypeScript widens the JSON literal's `speaker: number` past `SpeakerId`.
 */
export const SAMPLE_SHARE_VIEW = samplePayload as unknown as PublicShareView;

/** The same newscast with every metadata flag off — the `metadata: {}` case. */
export const SAMPLE_SHARE_VIEW_WITHOUT_METADATA: PublicShareView = {
  ...SAMPLE_SHARE_VIEW,
  metadata: {},
};

/** A single-part newscast, i.e. what the worker normalizes a legacy job into. */
export const SAMPLE_SINGLE_PART_SHARE_VIEW: PublicShareView = {
  ...SAMPLE_SHARE_VIEW,
  parts: [SAMPLE_SHARE_VIEW.parts[0]],
  hasSignalAudio: false,
};
