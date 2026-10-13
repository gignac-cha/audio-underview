import { CRAWLER_LOG_ENTRY_OVERHEAD, CRAWLER_LOG_MAXIMUM_COST, CRAWLER_LOG_MAXIMUM_ENTRIES } from '@audio-underview/worker-tools';
import { REDIRECT_MODE_HEADER } from './outbound-gateway.ts';
import { REDACTED_MARKER } from './redaction.ts';

/**
 * The main module of every crawler Dynamic Worker. It imports the crawler code (crawler.js, a
 * CommonJS module so the code keeps sloppy mode) and runs it once per run() call:
 * - console output is collected per run (AsyncLocalStorage), redacted and limited
 * - fetch sends the redirect mode the code asked for to the outbound gateway, which follows redirects
 * - context.files wraps the file capability of the run
 * - the run ends with the result as JSON, or with the error, after timeoutMilliseconds at the latest
 *
 * It is a fixed string, part of the isolate ID, and cannot import the crawler manager's modules,
 * so it carries its own copy of the redaction rules (redaction.ts).
 */

export const CRAWLER_FILE_MAXIMUM_SIZE = 26_214_400;
export const CRAWLER_ERROR_MESSAGE_MAXIMUM_LENGTH = 2_000;
export const CRAWLER_STACK_MAXIMUM_LENGTH = 4_000;
export const FILES_UNAVAILABLE_MESSAGE = 'Files are not available in this run';
export const FILE_TOO_LARGE_MESSAGE = `File exceeds the maximum size of ${CRAWLER_FILE_MAXIMUM_SIZE} bytes`;

/** What CrawlerRunner.run answers */
export type RunnerResponse =
  | { ok: true; resultJSON: string; logs: unknown; logsTruncated: unknown }
  | { ok: false; timedOut: boolean; errorMessage: string; logs: unknown; logsTruncated: unknown };

const RUNNER_CONSTANTS = [
  `const LOG_MAXIMUM_COST = ${CRAWLER_LOG_MAXIMUM_COST};`,
  `const LOG_MAXIMUM_ENTRIES = ${CRAWLER_LOG_MAXIMUM_ENTRIES};`,
  `const LOG_ENTRY_OVERHEAD = ${CRAWLER_LOG_ENTRY_OVERHEAD};`,
  `const STACK_MAXIMUM_LENGTH = ${CRAWLER_STACK_MAXIMUM_LENGTH};`,
  `const ERROR_MESSAGE_MAXIMUM_LENGTH = ${CRAWLER_ERROR_MESSAGE_MAXIMUM_LENGTH};`,
  `const FILE_MAXIMUM_SIZE = ${CRAWLER_FILE_MAXIMUM_SIZE};`,
  `const REDACTED = ${JSON.stringify(REDACTED_MARKER)};`,
  `const REDIRECT_MODE_HEADER = ${JSON.stringify(REDIRECT_MODE_HEADER)};`,
  `const FILES_UNAVAILABLE = ${JSON.stringify(FILES_UNAVAILABLE_MESSAGE)};`,
  `const FILE_TOO_LARGE = ${JSON.stringify(FILE_TOO_LARGE_MESSAGE)};`,
].join('\n');

const RUNNER_BODY = String.raw`
const runs = new AsyncLocalStorage();
const TIMED_OUT = Symbol('timed out');

function createRedactor(environment) {
  const forms = new Set();
  for (const value of Object.values(environment)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    forms.add(value);
    forms.add(JSON.stringify(value).slice(1, -1));
    forms.add(encodeURIComponent(value));
  }
  const orderedForms = Array.from(forms).filter((form) => form.length > 0).sort((left, right) => right.length - left.length);
  return (text) => {
    let redacted = text;
    for (const form of orderedForms) {
      if (redacted.includes(form)) redacted = redacted.split(form).join(REDACTED);
    }
    return redacted;
  };
}

// Postgres JSONB refuses NUL and unpaired surrogates
function cleanText(text) {
  return text.replace(/\u0000/g, '�').toWellFormed();
}

// Cuts without splitting a surrogate pair
function cutText(text, length) {
  if (text.length <= length) return text;
  let end = length;
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function stringOf(value) {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// Formatting a logged value runs code of the crawler (getters, proxy traps), which can throw. A console
// method must never throw, so every read is guarded and the last fallback is a constant.
const UNPRINTABLE = '[unprintable]';

function isError(value) {
  try {
    return value instanceof Error;
  } catch {
    // A proxy whose getPrototypeOf trap throws, or a revoked proxy
    return false;
  }
}

function propertyText(value, key) {
  try {
    return stringOf(value[key]);
  } catch {
    return undefined;
  }
}

function errorText(value) {
  try {
    const stack = value.stack;
    if (typeof stack === 'string' && stack.length > 0) return stack;
  } catch {
    // Described by its name and message instead
  }
  const name = propertyText(value, 'name') ?? 'Error';
  const message = propertyText(value, 'message');
  return message === undefined ? name : name + ': ' + message;
}

function formatArgument(value) {
  if (typeof value === 'string') return value;
  if (isError(value)) return errorText(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Not representable as JSON (BigInt, a circular reference)
  }
  try {
    return stringOf(value);
  } catch {
    return UNPRINTABLE;
  }
}

function appendEntry(run, level, message) {
  if (run.logsTruncated) return;
  if (run.logs.length >= LOG_MAXIMUM_ENTRIES) {
    run.logsTruncated = true;
    return;
  }
  const remainingCost = LOG_MAXIMUM_COST - run.cost;
  if (message.length + LOG_ENTRY_OVERHEAD > remainingCost) {
    const allowedLength = remainingCost - LOG_ENTRY_OVERHEAD;
    if (allowedLength > 0) {
      run.logs.push({ level, message: cutText(message, allowedLength), timestamp: new Date().toISOString() });
    }
    run.cost = LOG_MAXIMUM_COST;
    run.logsTruncated = true;
    return;
  }
  run.logs.push({ level, message, timestamp: new Date().toISOString() });
  run.cost += message.length + LOG_ENTRY_OVERHEAD;
}

function record(level, data) {
  const run = runs.getStore();
  // Outside a run, or after the run returned its result
  if (run === undefined || run.finished) return;
  const message = data.map(formatArgument).join(' ');
  // Redacted before it is cut, so no prefix of a value can stay
  appendEntry(run, level, cleanText(run.redact(message)));
}

const LEVEL_OF_CONSOLE_METHOD = { log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug', dir: 'log', table: 'log', trace: 'log' };
for (const method of Object.keys(LEVEL_OF_CONSOLE_METHOD)) {
  const level = LEVEL_OF_CONSOLE_METHOD[method];
  console[method] = (...data) => record(level, data);
}
console.assert = (condition, ...data) => {
  if (!condition) record('error', data.length === 0 ? ['Assertion failed'] : data);
};
for (const method of ['group', 'groupCollapsed', 'groupEnd', 'count', 'countReset', 'time', 'timeEnd', 'timeLog']) {
  console[method] = () => {};
}

// The outbound gateway sees every request as redirect 'manual', so the mode the code asked for
// travels in a header and the gateway follows redirects itself
const nativeFetch = globalThis.fetch;
globalThis.fetch = function fetch(input, init) {
  try {
    let redirect = 'follow';
    if (init !== undefined && init !== null && init.redirect !== undefined) {
      redirect = String(init.redirect);
    } else if (input instanceof Request) {
      redirect = input.redirect;
    }
    if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
      throw new TypeError("Invalid redirect value, must be one of 'follow', 'manual' or 'error'");
    }
    const options = init === undefined || init === null || init instanceof Request ? init : Object.assign({}, init, { redirect: 'manual' });
    let request = new Request(input, options);
    if (request.redirect !== 'manual') request = new Request(request, { redirect: 'manual' });
    request.headers.set(REDIRECT_MODE_HEADER, redirect);
    return nativeFetch(request);
  } catch (error) {
    return Promise.reject(error);
  }
};

async function collectStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk;
    if (typeof value === 'string') chunk = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) chunk = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else {
      await reader.cancel().catch(() => {});
      throw new TypeError('ReadableStream chunks must be bytes or strings');
    }
    size += chunk.byteLength;
    if (size > FILE_MAXIMUM_SIZE) {
      await reader.cancel().catch(() => {});
      throw new Error(FILE_TOO_LARGE);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function prepareFileData(data) {
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return { size: data.byteLength, data };
  if (data instanceof Blob) return { size: data.size, data };
  if (data instanceof ReadableStream) {
    const bytes = await collectStream(data);
    return { size: bytes.byteLength, data: bytes };
  }
  const buffer = await new Response(data).arrayBuffer();
  return { size: buffer.byteLength, data: buffer };
}

function createFiles(capability) {
  const available = capability !== undefined && capability !== null;
  return Object.freeze({
    async save(data, options) {
      if (!available) throw new Error(FILES_UNAVAILABLE);
      const prepared = await prepareFileData(data);
      if (prepared.size > FILE_MAXIMUM_SIZE) throw new Error(FILE_TOO_LARGE);
      const stream = new Response(prepared.data).body ?? new ReadableStream({ start(controller) { controller.close(); } });
      const fileOptions = options !== null && typeof options === 'object' ? options : {};
      return capability.save(stream, { size: prepared.size, name: fileOptions.name, contentType: fileOptions.contentType });
    },
    async read(reference) {
      if (!available) throw new Error(FILES_UNAVAILABLE);
      const fileID = typeof reference === 'string' ? reference : reference !== null && typeof reference === 'object' ? reference.file_id : undefined;
      const file = await capability.read(fileID);
      return new Response(file.body, {
        headers: { 'content-type': file.content_type, 'content-length': String(file.size) },
      });
    },
  });
}

// Reading the thrown value runs code of the crawler (getters, proxy traps), which can throw too
function messageOf(thrown) {
  try {
    if (thrown instanceof Error) return stringOf(thrown.message);
  } catch {
    // Described below like anything else thrown
  }
  try {
    return String(thrown);
  } catch {
    // Not convertible to a string
  }
  try {
    return Object.prototype.toString.call(thrown);
  } catch {
    return 'Unknown execution error';
  }
}

function stackOf(thrown) {
  try {
    if (thrown instanceof Error) {
      const stack = thrown.stack;
      if (typeof stack === 'string' && stack.length > 0) return stack;
    }
  } catch {
    // No stack to show
  }
  return undefined;
}

export class CrawlerRunner extends WorkerEntrypoint {
  async run(input, capabilities) {
    const environment = capabilities.environment !== null && typeof capabilities.environment === 'object' ? capabilities.environment : {};
    const run = { logs: [], cost: 0, logsTruncated: false, finished: false, redact: createRedactor(environment) };
    return runs.run(run, async () => {
      const context = Object.freeze({
        environment: Object.freeze(Object.assign({}, environment)),
        files: createFiles(capabilities.files),
      });
      let timer;
      try {
        if (typeof crawler !== 'function') throw new Error('Crawler code must evaluate to a function');
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), capabilities.timeoutMilliseconds);
        });
        const value = await Promise.race([Promise.resolve().then(() => crawler(input, context)), timeout]);
        if (value === TIMED_OUT) {
          run.finished = true;
          return { ok: false, timedOut: true, errorMessage: '', logs: run.logs, logsTruncated: run.logsTruncated };
        }
        const resultJSON = JSON.stringify(value === undefined ? null : value) ?? 'null';
        run.finished = true;
        return { ok: true, resultJSON, logs: run.logs, logsTruncated: run.logsTruncated };
      } catch (thrown) {
        run.finished = true;
        const errorMessage = cutText(cleanText(run.redact(messageOf(thrown))), ERROR_MESSAGE_MAXIMUM_LENGTH);
        const stack = stackOf(thrown);
        if (stack !== undefined) {
          // Kept whatever the limits, so the end of the logs shows where the run failed
          run.logs.push({
            level: 'error',
            message: cutText(cleanText(run.redact(stack)), STACK_MAXIMUM_LENGTH),
            timestamp: new Date().toISOString(),
          });
        }
        return { ok: false, timedOut: false, errorMessage, logs: run.logs, logsTruncated: run.logsTruncated };
      } finally {
        clearTimeout(timer);
      }
    });
  }
}
`;

export const RUNNER_MODULE_SOURCE = [
  "import { WorkerEntrypoint } from 'cloudflare:workers';",
  "import { AsyncLocalStorage } from 'node:async_hooks';",
  "import crawler from './crawler.js';",
  RUNNER_CONSTANTS,
  RUNNER_BODY,
].join('\n');
