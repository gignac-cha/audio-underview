import { vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { LLM_PROVIDERS, type LlmProvider } from '@audio-underview/newscast-core';
import worker from '../sources/index.ts';
import type { Environment, NewscastRequest, NewscastWorkflowParameters } from '../sources/environment.ts';

/**
 * What the tests of the newscast Workflow share: a real execution context, a step that runs every
 * callback at once, and the answers the stand-ins of vitest.config.ts give for the provider calls.
 */

export const environment = env as unknown as Environment;

/**
 * The constructor of WorkflowEntrypoint only accepts an ExecutionContext workerd created itself, and
 * rejects the stand-in createExecutionContext() returns. The main worker runs in the isolate of the
 * test and receives a real one in fetch(), so the test takes it from a request to SELF.
 */
export async function receiveExecutionContext(): Promise<ExecutionContext> {
  const received: { executionContext?: ExecutionContext } = {};
  const spy = vi.spyOn(worker, 'fetch').mockImplementation((async (_request: Request, _environment: unknown, executionContext: ExecutionContext) => {
    received.executionContext = executionContext;
    return new Response(null, { status: 204 });
  }) as unknown as typeof worker.fetch);
  try {
    await SELF.fetch('https://worker.example.com/');
  } finally {
    spy.mockRestore();
  }
  if (received.executionContext === undefined) throw new Error('The main worker did not receive an execution context');
  return received.executionContext;
}

/** A step that runs each callback once, as a step that succeeds on its first attempt, and records its name */
export function createFakeStep(): { step: WorkflowStep; names: string[] } {
  const names: string[] = [];
  const step = {
    async do<T>(name: string, configurationOrCallback: unknown, maybeCallback?: () => Promise<T>): Promise<T> {
      names.push(name);
      const callback = (typeof configurationOrCallback === 'function' ? configurationOrCallback : maybeCallback) as () => Promise<T>;
      return callback();
    },
  };
  return { step: step as unknown as WorkflowStep, names };
}

export function workflowEvent(payload: NewscastWorkflowParameters): WorkflowEvent<NewscastWorkflowParameters> {
  return {
    payload,
    timestamp: new Date(),
    instanceId: `${payload.stageRunID}-0`,
    workflowName: 'audio-underview-newscast-workflow',
  } as WorkflowEvent<NewscastWorkflowParameters>;
}

export function newscastRequest(values: Partial<NewscastRequest>): NewscastRequest {
  return {
    limit: 1,
    provider: 'google',
    lengthPreference: 'standard',
    ttsModel: 'gemini-2.5-flash-preview-tts',
    speaker1Voice: 'Charon',
    speaker2Voice: 'Leda',
    signal: false,
    ...values,
  };
}

export async function configureVault(userID: string, responses: Record<string, unknown>): Promise<void> {
  await environment.USER_VAULT.fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ userId: userID, responses }),
  });
}

export interface VaultRequest {
  userId: string;
  route: string;
  token: string | null;
  body: { provider: string; path: string; body?: string; bodyBase64?: string } & Record<string, unknown>;
}

export async function vaultRequests(userID: string): Promise<VaultRequest[]> {
  const response = await environment.USER_VAULT.fetch(`https://stand-in.example.com/__test__/requests?userId=${userID}`);
  return response.json();
}

export async function configureCrawler(name: string, input: unknown, answer: unknown): Promise<void> {
  await (environment.CRAWLER_MANAGER as unknown as Fetcher).fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ name, input, answer }),
  });
}

export async function crawlerCalls(): Promise<Array<{ name: string; input: { url: string } }>> {
  const response = await (environment.CRAWLER_MANAGER as unknown as Fetcher).fetch('https://stand-in.example.com/__test__/calls');
  return response.json();
}

export async function schedulerCalls(stageRunID: string): Promise<Array<Record<string, unknown>>> {
  const response = await (environment.SCHEDULER_TASK_GROUP_REPORTS as unknown as Fetcher)
    .fetch(`https://stand-in.example.com/__test__/calls?stageRunID=${stageRunID}`);
  return response.json();
}

export async function configureScheduler(stageRunID: string, answers: Record<string, unknown>): Promise<void> {
  await (environment.SCHEDULER_TASK_GROUP_REPORTS as unknown as Fetcher).fetch('https://stand-in.example.com/__test__/configure', {
    method: 'POST',
    body: JSON.stringify({ stageRunID, answers }),
  });
}

/** The vault path of the default TTS model's request */
export const TEXT_TO_SPEECH_PATH = 'v1beta/models/gemini-2.5-flash-preview-tts:generateContent';
/** The vault path of the Lyria sting request */
export const SIGNAL_PATH = 'v1beta/interactions';

/** 100 ms of 24 kHz mono 16-bit silence, base64 */
const SILENCE_BASE64 = btoa(String.fromCharCode(...new Uint8Array(4_800)));

/** The vault's answer for a proxied call the provider answered with `status` and `body` */
export function providerAnswer(body: unknown, status = 200): { status: number; body: unknown } {
  return { status: 200, body: { ok: true, provider: 'google', status, body: typeof body === 'string' ? body : JSON.stringify(body) } };
}

/** A Gemini TTS answer carrying 100 ms of PCM */
export function textToSpeechAnswer() {
  return providerAnswer({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: SILENCE_BASE64 } }] } }],
  });
}

/** A Gemini generateContent answer whose text is `value` as JSON */
export function geminiTextAnswer(value: unknown) {
  return providerAnswer({
    candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  });
}

/** A Lyria answer carrying the clip "ABC" */
export function signalAnswer() {
  return providerAnswer({ outputs: [{ type: 'audio', mimeType: 'audio/mpeg', data: 'QUJD' }] });
}

/** What the vault answers for a provider the user has no key for */
export const NO_KEY_ANSWER = { status: 404, body: { ok: false, error: 'no_key' } };

/** The vault path of the Whisper transcription request */
export const TRANSCRIPTION_PATH = 'v1/audio/transcriptions';

/** The vault's keys/status answer for a user whose registered keys are those of `configured` */
export function keyStatusAnswer(configured: LlmProvider[]): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      keys: LLM_PROVIDERS.map((provider) => configured.includes(provider)
        ? { provider, configured: true, last4: 'abcd', validatedAt: '2026-10-26T00:00:00.000Z' }
        : { provider, configured: false, last4: null, validatedAt: null }),
    },
  };
}

/** A Whisper verbose_json answer hearing `words` in order, spread over the 100 ms a chunk lasts */
export function transcriptionAnswer(words: string[]) {
  const span = 0.1 / words.length;
  return providerAnswer({
    text: words.join(' '),
    words: words.map((word, index) => ({ word, start: index * span, end: (index + 1) * span })),
  });
}

export const ORGANIZE_ANSWER = geminiTextAnswer({
  units: [{ kind: 'fact', headline: '핵심 사실', detail: '기사가 전하는 핵심 사실입니다.', weight: 3 }],
});

export const SCRIPT_ANSWER = geminiTextAnswer({
  lines: [
    { speaker: 1, text: '안녕하세요, 오늘의 소식입니다.' },
    { speaker: 2, text: '네, 핵심 사실부터 보시죠.' },
  ],
});
