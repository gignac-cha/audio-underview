import { createContext, Script } from 'node:vm';

/**
 * 사용자 크롤러 코드 실행 sandbox (node:vm — 스펙 §5.3).
 *
 * - globals는 allowlist만 노출: fetch/require/process/timer 없음
 *   → 사용자 코드는 네트워크/파일시스템/프로세스에 접근할 수 없다.
 * - 비문자열 인자는 sandbox 컨텍스트 안에서 `JSON.parse`로 재생성 —
 *   sandbox 내 `Array.isArray`/`instanceof`가 올바르게 동작하도록 (테스트로 고정).
 * - timeout 2중: 동기 실행은 vm timeout, async 함수는 Promise.race (5초).
 */

export const EXECUTION_TIMEOUT_MILLISECONDS = 5_000;

export class SandboxTimeoutError extends Error {
  constructor(timeoutMilliseconds: number) {
    super(`Code execution timed out after ${timeoutMilliseconds}ms`);
    this.name = 'SandboxTimeoutError';
  }
}

const createSandboxGlobals = (): Record<string, unknown> => ({
  Array,
  Boolean,
  Date,
  Error,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  RegExp,
  Set,
  String,
  TypeError,
  RangeError,
  URL,
  URLSearchParams,
  parseInt,
  parseFloat,
  isNaN,
  isFinite,
  encodeURIComponent,
  decodeURIComponent,
  encodeURI,
  decodeURI,
  undefined,
  NaN,
  Infinity,
});

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

export const executeInSandbox = async (
  code: string,
  argument: unknown,
  timeoutMilliseconds: number = EXECUTION_TIMEOUT_MILLISECONDS,
): Promise<unknown> => {
  const sandbox = createSandboxGlobals();
  let expression: string;

  if (typeof argument === 'string') {
    sandbox.__inputText = argument;
    expression = `(${code})(__inputText)`;
  } else {
    // JSON.stringify의 반환 타입은 string이지만 런타임에는 undefined(함수/undefined 인자)를
    // 반환할 수 있어 'null'로 보정한다 — 타입과 런타임의 알려진 괴리
    const serialized = JSON.stringify(argument) as string | undefined;
    sandbox.__inputJSON = serialized ?? 'null';
    expression = `(${code})(JSON.parse(__inputJSON))`;
  }

  const context = createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  let evaluated: unknown;
  try {
    const script = new Script(expression);
    evaluated = script.runInContext(context, { timeout: timeoutMilliseconds });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
    ) {
      throw new SandboxTimeoutError(timeoutMilliseconds);
    }
    throw error;
  }

  // vm 컨텍스트의 Promise는 다른 realm이라 instanceof 대신 thenable 검사
  if (!isThenable(evaluated)) {
    return evaluated;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SandboxTimeoutError(timeoutMilliseconds));
    }, timeoutMilliseconds);
    timer.unref();
  });

  try {
    return await Promise.race([Promise.resolve(evaluated), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};
