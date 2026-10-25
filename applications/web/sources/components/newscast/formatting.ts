/**
 * Pure display formatters for the Newscasts page (English UI chrome).
 * Ported from the old monolith page so every component shares one copy.
 */

/**
 * Parse the Postgres TIMESTAMPTZ `created_at` (ISO 8601 with its offset, as the
 * worker answers it) to epoch milliseconds, or `undefined` when it cannot be
 * parsed. Drives both display and elapsed timers.
 */
export function parseCreatedAtMilliseconds(createdAt: string): number | undefined {
  const milliseconds = Date.parse(createdAt);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/** Format the `created_at` as a local, English date/time. */
export function formatCreatedAt(createdAt: string): string {
  const milliseconds = parseCreatedAtMilliseconds(createdAt);
  if (milliseconds === undefined) {
    return createdAt;
  }
  return new Date(milliseconds).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Compact relative time for list rows: `32s ago` / `5m ago` / `2h ago`, falling
 * back to a short date beyond 24 hours. `nowMilliseconds` is injected so rows
 * re-render from the page's shared 1s tick (and tests stay deterministic).
 */
export function formatRelativeTime(milliseconds: number, nowMilliseconds: number): string {
  const delta = Math.max(0, nowMilliseconds - milliseconds);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return new Date(milliseconds).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format an elapsed duration in milliseconds as `mm:ss`. */
export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Format a duration in milliseconds as a short English string: `1.3s`, `1m 4s`. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const roundedSeconds = Math.round(totalSeconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

/** Format a UTF-8 byte count as `B` / `KB` / `MB` (one decimal for KB and MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1)} KB`;
  }
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

/** Format an integer count with thousands separators (e.g. `5,252`). */
export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Short, human-glanceable form of a newscast ID when no title is available yet. */
export function shortID(id: string): string {
  return id.slice(0, 8);
}
