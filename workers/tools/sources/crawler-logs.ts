import {
  type CrawlerLogEntry,
  CRAWLER_LOG_ENTRY_OVERHEAD,
  CRAWLER_LOG_MAXIMUM_COST,
  CRAWLER_LOG_MAXIMUM_ENTRIES,
} from './types.ts';

export interface CrawlerLogLimitOptions {
  /**
   * The last entry is the stack of a failed run: when the limits would cut or drop it, it is kept
   * outside them, cut to this many characters
   */
  trailingEntryMaximumLength?: number;
}

// Postgres JSONB refuses NUL and unpaired surrogates
function cleanText(text: string): string {
  return text.replace(/\u0000/g, '�').toWellFormed();
}

// Cuts without splitting a surrogate pair
function cutText(text: string, length: number): string {
  if (text.length <= length) {
    return text;
  }
  let end = length;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function limitEntries(entries: CrawlerLogEntry[]): { logs: CrawlerLogEntry[]; truncated: boolean } {
  const logs: CrawlerLogEntry[] = [];
  let cost = 0;
  for (const entry of entries) {
    if (logs.length >= CRAWLER_LOG_MAXIMUM_ENTRIES) {
      return { logs, truncated: true };
    }
    const message = cleanText(entry.message);
    const remainingCost = CRAWLER_LOG_MAXIMUM_COST - cost;
    if (message.length + CRAWLER_LOG_ENTRY_OVERHEAD > remainingCost) {
      const allowedLength = remainingCost - CRAWLER_LOG_ENTRY_OVERHEAD;
      if (allowedLength > 0) {
        logs.push({ ...entry, message: cutText(message, allowedLength) });
      }
      return { logs, truncated: true };
    }
    logs.push({ ...entry, message });
    cost += message.length + CRAWLER_LOG_ENTRY_OVERHEAD;
  }
  return { logs, truncated: false };
}

/**
 * Applies the limits of the logs of one crawler run: a cost of 65,536 (message length + 64 per
 * entry) and 1,000 entries. The entry that crosses the cost is cut; the entries after it are dropped.
 * NUL and unpaired surrogates are replaced.
 */
export function limitCrawlerLogs(
  entries: CrawlerLogEntry[],
  options: CrawlerLogLimitOptions = {},
): { logs: CrawlerLogEntry[]; truncated: boolean } {
  const limited = limitEntries(entries);
  // Without truncation every entry, the last one included, is kept whole
  if (options.trailingEntryMaximumLength === undefined || !limited.truncated) {
    return limited;
  }
  const lastEntry = entries[entries.length - 1];
  const lastMessage = cleanText(lastEntry.message);
  const { logs, truncated } = limitEntries(entries.slice(0, -1));
  logs.push({ ...lastEntry, message: cutText(lastMessage, options.trailingEntryMaximumLength) });
  return { logs, truncated: truncated || lastMessage.length > options.trailingEntryMaximumLength };
}
