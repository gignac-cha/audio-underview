import type { CrawlerLogEntry } from '@audio-underview/worker-tools';

/**
 * Hides the values of the environment variables of a run in what the run produced. The runner module
 * applies the same rules inside the Dynamic Worker (it cannot import this file); the crawler manager
 * applies them again to everything the runner returns.
 */

export const REDACTED_MARKER = '[REDACTED]';

export interface Redactor {
  redactText(text: string): string;
  /** Redacts strings, array items, and object keys and values, recursively */
  redactValue(value: unknown): unknown;
  redactLogs(entries: CrawlerLogEntry[]): CrawlerLogEntry[];
}

/**
 * Each value is hidden in three forms: as it is, inside a JSON string (escaped), and URL-encoded.
 * The longest forms are replaced first, so a value that contains another is hidden whole.
 */
export function createRedactor(environment: Record<string, string>): Redactor {
  const forms = new Set<string>();
  for (const value of Object.values(environment)) {
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(encodeURIComponent(value));
  }
  const orderedForms = [...forms]
    .filter((form) => form.length > 0)
    .sort((left, right) => right.length - left.length);

  if (orderedForms.length === 0) {
    return {
      redactText: (text) => text,
      redactValue: (value) => value,
      redactLogs: (entries) => entries,
    };
  }

  const redactText = (text: string): string => {
    let redacted = text;
    for (const form of orderedForms) {
      if (redacted.includes(form)) {
        redacted = redacted.split(form).join(REDACTED_MARKER);
      }
    }
    return redacted;
  };

  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === 'object') {
      const redacted: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        // defineProperty keeps a key such as __proto__ an ordinary property
        Object.defineProperty(redacted, redactText(key), {
          value: redactValue(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return redacted;
    }
    return value;
  };

  const redactLogs = (entries: CrawlerLogEntry[]): CrawlerLogEntry[] =>
    entries.map((entry) => ({ ...entry, message: redactText(entry.message) }));

  return { redactText, redactValue, redactLogs };
}
