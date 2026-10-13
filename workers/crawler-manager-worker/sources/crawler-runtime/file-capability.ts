import { RpcTarget } from 'cloudflare:workers';
import type { Logger } from '@audio-underview/logger';
import {
  type SupabaseClient,
  createCrawlerFile,
  getCrawlerFileForUser,
  crawlerFileExists,
  deleteCrawlerFile,
} from '@audio-underview/supabase-connector';
import { isUUID } from '../identifiers.ts';
import type { Redactor } from './redaction.ts';
import { CRAWLER_FILE_MAXIMUM_SIZE, FILES_UNAVAILABLE_MESSAGE, FILE_TOO_LARGE_MESSAGE } from './runner-module.ts';

/**
 * The files of one run, handed to its Dynamic Worker inside the run() argument. Over RPC only the
 * methods of the prototype are visible; the fields are private as well. The host closes it when the
 * run ends, so code that keeps running after a timeout cannot add files.
 */

export const DIRECT_RUN_FILE_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1_000;
export const FILE_NAME_MAXIMUM_LENGTH = 255;
export const CONTENT_TYPE_MAXIMUM_LENGTH = 255;
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,127}\/[A-Za-z0-9!#$&^_.+-]{1,127}(;[^\r\n]*)?$/;
// U+0000-U+001F and U+007F
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const FILE_NOT_FOUND_MESSAGE = 'File not found';
const FILE_NOT_SAVED_MESSAGE = 'File could not be saved';

export interface CrawlerFileReference {
  file_id: string;
  name: string | null;
  content_type: string;
  size: number;
}

export interface CrawlerFileContent {
  body: ReadableStream;
  name: string | null;
  content_type: string;
  size: number;
}

export interface CrawlerFileCapabilityOptions {
  userUUID: string;
  /** The scheduler run; absent for a direct run, whose files expire after 24 hours */
  runID: string | undefined;
  crawlerID: string;
  supabaseClient: SupabaseClient;
  bucket: R2Bucket;
  redactor: Redactor;
  logger: Logger;
}

async function cancelQuietly(stream: unknown): Promise<void> {
  try {
    await (stream as ReadableStream).cancel();
  } catch {
    // Not a stream, or already read
  }
}

function codePointLength(text: string): number {
  return [...text].length;
}

function readFileName(name: unknown, redactor: Redactor): string | null {
  if (name === undefined || name === null) {
    return null;
  }
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    codePointLength(name) > FILE_NAME_MAXIMUM_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(name)
  ) {
    throw new Error('Invalid file name');
  }
  // The marker is longer than a short value, so a redacted name can outgrow the limit
  return [...redactor.redactText(name)].slice(0, FILE_NAME_MAXIMUM_LENGTH).join('');
}

function readContentType(contentType: unknown): string {
  if (contentType === undefined || contentType === null) {
    return DEFAULT_CONTENT_TYPE;
  }
  if (
    typeof contentType !== 'string' ||
    contentType.length > CONTENT_TYPE_MAXIMUM_LENGTH ||
    !CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw new Error('Invalid content type');
  }
  return contentType;
}

export class CrawlerFileCapability extends RpcTarget {
  #userUUID: string;
  #runID: string | undefined;
  #crawlerID: string;
  #supabaseClient: SupabaseClient;
  #bucket: R2Bucket;
  #redactor: Redactor;
  #logger: Logger;
  #closed = false;

  constructor(options: CrawlerFileCapabilityOptions) {
    super();
    this.#userUUID = options.userUUID;
    this.#runID = options.runID;
    this.#crawlerID = options.crawlerID;
    this.#supabaseClient = options.supabaseClient;
    this.#bucket = options.bucket;
    this.#redactor = options.redactor;
    this.#logger = options.logger;
  }

  /** Not a method of the instance, so the Dynamic Worker cannot call it */
  static close(capability: CrawlerFileCapability): void {
    capability.#closed = true;
  }

  async save(
    stream: ReadableStream,
    options: { size: unknown; name?: unknown; contentType?: unknown },
  ): Promise<CrawlerFileReference> {
    let size: number;
    let name: string | null;
    let contentType: string;
    try {
      if (this.#closed) {
        throw new Error(FILES_UNAVAILABLE_MESSAGE);
      }
      const requestedSize = options?.size;
      if (typeof requestedSize !== 'number' || !Number.isInteger(requestedSize) || requestedSize < 0) {
        throw new Error('Invalid file size');
      }
      if (requestedSize > CRAWLER_FILE_MAXIMUM_SIZE) {
        throw new Error(FILE_TOO_LARGE_MESSAGE);
      }
      size = requestedSize;
      name = readFileName(options.name, this.#redactor);
      contentType = readContentType(options.contentType);
    } catch (error) {
      await cancelQuietly(stream);
      throw error;
    }
    return this.#store(stream, size, name, contentType);
  }

  async #store(stream: ReadableStream, size: number, name: string | null, contentType: string): Promise<CrawlerFileReference> {
    const id = crypto.randomUUID();
    const objectKey = `${this.#userUUID}/${id}`;

    try {
      await createCrawlerFile(this.#supabaseClient, {
        id,
        user_uuid: this.#userUUID,
        crawler_id: this.#crawlerID,
        object_key: objectKey,
        name,
        content_type: contentType,
        size,
        ...(this.#runID === undefined
          ? { expires_at: new Date(Date.now() + DIRECT_RUN_FILE_LIFETIME_MILLISECONDS).toISOString() }
          : { run_id: this.#runID }),
      });
    } catch {
      this.#logger.error('Crawler file could not be recorded', undefined, {
        function: 'save',
        metadata: { crawlerID: this.#crawlerID },
      });
      await cancelQuietly(stream);
      throw new Error(FILE_NOT_SAVED_MESSAGE);
    }

    try {
      const { readable, writable } = new FixedLengthStream(size);
      await Promise.all([
        stream.pipeTo(writable),
        this.#bucket.put(objectKey, readable, { httpMetadata: { contentType } }),
      ]);
    } catch {
      this.#logger.error('Crawler file could not be stored', undefined, {
        function: 'save',
        metadata: { crawlerID: this.#crawlerID, fileID: id },
      });
      await this.#deleteRow(id);
      throw new Error(FILE_NOT_SAVED_MESSAGE);
    }

    // The host gave up on the run while the object was written: the file goes with the run
    if (this.#closed) {
      await this.#deleteRow(id);
      throw new Error(FILES_UNAVAILABLE_MESSAGE);
    }

    // The row can go while the object is written (its run or user was deleted); the object goes with it
    let exists: boolean;
    try {
      exists = await crawlerFileExists(this.#supabaseClient, id);
    } catch {
      // Unknown: give the file up whole
      await this.#deleteRow(id);
      exists = false;
    }
    if (!exists) {
      await this.#bucket.delete(objectKey).catch(() => {
        this.#logger.error('Crawler file object could not be deleted', undefined, {
          function: 'save',
          metadata: { crawlerID: this.#crawlerID, fileID: id },
        });
      });
      throw new Error(FILE_NOT_SAVED_MESSAGE);
    }

    return { file_id: id, name, content_type: contentType, size };
  }

  /** The trigger queues the object key, so the cron removes whatever reached R2 */
  async #deleteRow(id: string): Promise<void> {
    try {
      await deleteCrawlerFile(this.#supabaseClient, id);
    } catch {
      this.#logger.error('Crawler file row could not be deleted', undefined, {
        function: 'save',
        metadata: { crawlerID: this.#crawlerID, fileID: id },
      });
    }
  }

  async read(fileID: unknown): Promise<CrawlerFileContent> {
    if (this.#closed) {
      throw new Error(FILES_UNAVAILABLE_MESSAGE);
    }
    // A missing file, a file of another user and an expired file look the same
    if (typeof fileID !== 'string' || !isUUID(fileID)) {
      throw new Error(FILE_NOT_FOUND_MESSAGE);
    }
    const file = await getCrawlerFileForUser(this.#supabaseClient, fileID, this.#userUUID);
    if (file === undefined) {
      throw new Error(FILE_NOT_FOUND_MESSAGE);
    }
    const object = await this.#bucket.get(file.object_key);
    if (object === null) {
      throw new Error(FILE_NOT_FOUND_MESSAGE);
    }
    return { body: object.body, name: file.name, content_type: file.content_type, size: object.size };
  }
}

/**
 * Ends the run for the files: save and read throw from now on.
 */
export function closeFileCapability(capability: CrawlerFileCapability): void {
  CrawlerFileCapability.close(capability);
}
