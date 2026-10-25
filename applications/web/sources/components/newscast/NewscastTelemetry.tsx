/**
 * The finished (or failed) newscast's pipeline, as the same compact stage rows
 * the running tracker shows. Each row carries one key metric and opens the full
 * per-stage telemetry in a dialog, so this surface renders no detail cards of
 * its own.
 *
 * Returns null when the newscast recorded no telemetry at all, so callers can
 * mount it unconditionally.
 */

import type { JobDetails, JobStatus } from '@audio-underview/newscast-core';

import { StageRowList } from './StageRow.tsx';

function hasTelemetry(details: JobDetails | undefined): details is JobDetails {
  if (details === undefined) {
    return false;
  }
  return (
    details.crawlList !== undefined ||
    details.crawlArticles !== undefined ||
    details.organize !== undefined ||
    details.script !== undefined ||
    details.tts !== undefined ||
    details.merge !== undefined ||
    details.partsSummary !== undefined
  );
}

export interface NewscastTelemetryProps {
  /** The whole status: rows need the stage/run state, not just the details. */
  status: JobStatus;
}

export function NewscastTelemetry({ status }: NewscastTelemetryProps) {
  if (!hasTelemetry(status.details)) {
    return null;
  }
  return <StageRowList status={status} />;
}
