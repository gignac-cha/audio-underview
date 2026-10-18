/**
 * A file the crawler code saved, as it stands in the crawler's result.
 */
export interface CrawlerFileReference {
  file_id: string;
  content_type: string;
  size: number;
  name: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A result is JSON, so it has no cycles; the limit only guards against a result nested absurdly deep
const MAXIMUM_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toFileReference(value: Record<string, unknown>): CrawlerFileReference | undefined {
  const { file_id: fileID, content_type: contentType, size, name } = value;
  if (
    typeof fileID === 'string' &&
    UUID_PATTERN.test(fileID) &&
    typeof contentType === 'string' &&
    typeof size === 'number' &&
    (typeof name === 'string' || name === null)
  ) {
    return { file_id: fileID, content_type: contentType, size, name };
  }
  return undefined;
}

/**
 * Finds the file references anywhere inside a result, in the order they appear. A file referenced
 * more than once is listed once.
 */
export function findFileReferences(result: unknown): CrawlerFileReference[] {
  const references = new Map<string, CrawlerFileReference>();

  const visit = (value: unknown, depth: number) => {
    if (depth > MAXIMUM_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;

    const reference = toFileReference(value);
    if (reference !== undefined) {
      if (!references.has(reference.file_id)) {
        references.set(reference.file_id, reference);
      }
      return;
    }
    for (const item of Object.values(value)) visit(item, depth + 1);
  };

  visit(result, 0);
  return [...references.values()];
}
