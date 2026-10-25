/**
 * The start request of the task group "newscast" (design §2), checked and turned into one
 * newscast source per article. Pure, so every rule is unit-testable without a Workers runtime.
 *
 * The scheduler checks the input only against the wide `{ "type": ["array", "object"] }` schema
 * and the settings against the settings schema, so the shapes are checked here. A start request
 * that breaks a rule throws a {@link TaskGroupInputError} whose message says what is wrong; the
 * scheduler then fails the stage with it.
 */

import type { GeekNewsEntry, LlmProvider, NewscastLengthPreference } from '@audio-underview/newscast-core';
import { DEFAULT_TTS_MODEL, MAX_PARALLEL_NEWSCASTS, TTS_MODELS, isTtsModel } from '@audio-underview/newscast-core';
import type { ScriptEffort } from '@audio-underview/newscast-script';
import { VERBATIM_LINE_CHARACTER_LIMIT } from '@audio-underview/newscast-script/verbatim-script.ts';
import {
  MAXIMUM_ARTICLE_CONTENT_LENGTH,
  type CustomArticleError,
  type CustomArticleInput,
  resolveCreateJobPlan,
  resolveCustomArticleTitle,
} from './custom-article.ts';
import { parseProvider, type NewscastRequest } from './environment.ts';

/** A start request the group cannot run; the message says what is wrong with it. */
export class TaskGroupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskGroupInputError';
  }
}

/** The settings of the stage, with the defaults of design §2 filled in. */
export interface NewscastSettings {
  provider: LlmProvider;
  /** Absent: the provider's default model */
  model?: string;
  /** Absent: no effort is sent */
  effort?: ScriptEffort;
  lengthPreference: NewscastLengthPreference;
  ttsModel: string;
  signal: boolean;
  verbatim: boolean;
  articleLimit: number;
}

/** One article of the input, which becomes one newscast. */
export type NewscastSource =
  /** An article of a list (a previous stage's output, or the picks of a form) */
  | { kind: 'article'; entry: GeekNewsEntry }
  /** `{ url }`: read with the article-content crawler alone */
  | { kind: 'url'; url: string }
  /** `{ text, title? }`: the text itself, never crawled */
  | { kind: 'text'; customArticle: CustomArticleInput };

/** The start request, checked. */
export interface NewscastStart {
  stageRunID: string;
  userUUID: string;
  settings: NewscastSettings;
  sources: NewscastSource[];
}

export const DEFAULT_ARTICLE_LIMIT = 3;

/** One newscast per article, and at most this many newscasts per stage run */
const MAXIMUM_ARTICLE_LIMIT = MAX_PARALLEL_NEWSCASTS;

// The vault answers 400 to a user id in any other form, so an uppercase UUID is refused here
const LOWERCASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SCRIPT_EFFORTS: readonly ScriptEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const LENGTH_PREFERENCES: readonly NewscastLengthPreference[] = ['short', 'standard', 'long'];

/** What each rejected pasted text says to the user. */
const CUSTOM_ARTICLE_ERROR_MESSAGES: Record<CustomArticleError, string> = {
  conflicting_source: 'The input has both articles and a text; give one of them.',
  empty_content: "The input field 'text' is empty.",
  content_too_long: `The input field 'text' is longer than ${MAXIMUM_ARTICLE_CONTENT_LENGTH.toLocaleString('en-US')} characters.`,
  empty_verbatim_script:
    "The input field 'text' has no line to read verbatim; every line is blank or a bare speaker prefix.",
  verbatim_line_too_long:
    `A line of the input field 'text' is longer than ${VERBATIM_LINE_CHARACTER_LIMIT.toLocaleString('en-US')} characters. ` +
    'Reading verbatim reads each line as one turn, so split long paragraphs into sentences.',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readEnumSetting<T extends string>(
  settings: Record<string, unknown>,
  key: string,
  values: readonly T[],
  defaultValue: T,
): T {
  const value = settings[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new TaskGroupInputError(`Setting '${key}' must be one of ${values.map((item) => `'${item}'`).join(', ')}.`);
  }
  return value as T;
}

function readBooleanSetting(settings: Record<string, unknown>, key: string): boolean {
  const value = settings[key];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new TaskGroupInputError(`Setting '${key}' must be true or false.`);
  }
  return value;
}

/**
 * The settings of the stage, with defaults for the keys it leaves out. A key with a value the
 * settings schema does not allow is an error rather than a silent default.
 */
export function parseNewscastSettings(settings: unknown): NewscastSettings {
  if (!isPlainObject(settings)) {
    throw new TaskGroupInputError('The settings must be an object.');
  }

  const provider = settings.provider === undefined ? 'google' : parseProvider(settings.provider);
  if (provider === undefined) {
    throw new TaskGroupInputError("Setting 'provider' must be one of 'google', 'anthropic', 'openai', 'xai'.");
  }

  let model: string | undefined;
  if (settings.model !== undefined) {
    if (typeof settings.model !== 'string') {
      throw new TaskGroupInputError("Setting 'model' must be a string.");
    }
    // Empty: the provider's default model (defaultModelForProvider)
    model = settings.model.trim().length > 0 ? settings.model.trim() : undefined;
  }

  // Empty: no effort is sent, and the provider's default applies
  const effort = readEnumSetting<ScriptEffort | ''>(settings, 'effort', ['', ...SCRIPT_EFFORTS], '');

  const ttsModel = settings.tts_model === undefined ? DEFAULT_TTS_MODEL : settings.tts_model;
  if (!isTtsModel(ttsModel)) {
    throw new TaskGroupInputError(
      `Setting 'tts_model' must be one of ${TTS_MODELS.map((option) => `'${option.id}'`).join(', ')}.`,
    );
  }

  const articleLimit = settings.article_limit === undefined ? DEFAULT_ARTICLE_LIMIT : settings.article_limit;
  if (
    typeof articleLimit !== 'number' ||
    !Number.isInteger(articleLimit) ||
    articleLimit < 1 ||
    articleLimit > MAXIMUM_ARTICLE_LIMIT
  ) {
    throw new TaskGroupInputError(`Setting 'article_limit' must be an integer from 1 to ${MAXIMUM_ARTICLE_LIMIT}.`);
  }

  return {
    provider,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== '' ? { effort } : {}),
    lengthPreference: readEnumSetting(settings, 'length', LENGTH_PREFERENCES, 'standard'),
    ttsModel,
    signal: readBooleanSetting(settings, 'signal'),
    verbatim: readBooleanSetting(settings, 'verbatim'),
    articleLimit,
  };
}

/**
 * One article of a list: a `{ title, discussionUrl, originalUrl }` object (the `geeknews-list`
 * output), trimmed. The title and the original URL must not be empty; the discussion URL may be,
 * and the GeekNews summary is then not read.
 */
function parseArticle(value: unknown, position: string): GeekNewsEntry {
  const article = isPlainObject(value) ? value : undefined;
  const title = typeof article?.title === 'string' ? article.title.trim() : '';
  const originalUrl = typeof article?.originalUrl === 'string' ? article.originalUrl.trim() : '';
  const discussionUrl = article?.discussionUrl;
  if (title.length === 0 || originalUrl.length === 0 || typeof discussionUrl !== 'string') {
    throw new TaskGroupInputError(
      `${position} is not an article: it needs a non-empty 'title' and 'originalUrl' and a 'discussionUrl' string.`,
    );
  }
  return { title, originalUrl, discussionUrl: discussionUrl.trim() };
}

function sourcesOfArticles(articles: GeekNewsEntry[], maximum: number): NewscastSource[] {
  const plan = resolveCreateJobPlan({ limit: 1, entries: articles, maxParallel: maximum });
  if (!plan.ok) {
    throw new TaskGroupInputError(CUSTOM_ARTICLE_ERROR_MESSAGES[plan.error]);
  }
  return plan.jobs.flatMap((job) => (job.entries ?? []).map((entry) => ({ kind: 'article' as const, entry })));
}

function parseURL(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TaskGroupInputError("The input field 'url' must be a string.");
  }
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TaskGroupInputError("The input field 'url' is not a URL.");
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TaskGroupInputError("The input field 'url' must be an http or https URL.");
  }
  return trimmed;
}

function parseText(input: Record<string, unknown>, settings: NewscastSettings): NewscastSource {
  if (typeof input.text !== 'string') {
    throw new TaskGroupInputError("The input field 'text' must be a string.");
  }
  if (input.title !== undefined && typeof input.title !== 'string') {
    throw new TaskGroupInputError("The input field 'title' must be a string.");
  }
  const customArticle: CustomArticleInput = { content: input.text.trim() };
  if (typeof input.title === 'string' && input.title.trim().length > 0) {
    customArticle.title = input.title.trim();
  }
  if (settings.verbatim) {
    customArticle.verbatim = true;
  }
  const plan = resolveCreateJobPlan({ limit: 1, customArticle, maxParallel: 1 });
  if (!plan.ok) {
    throw new TaskGroupInputError(CUSTOM_ARTICLE_ERROR_MESSAGES[plan.error]);
  }
  return { kind: 'text', customArticle };
}

const INPUT_SHAPES =
  'a list of articles, { articles: [...] }, { url } or { text, title? }';

/**
 * The sources of the input (design §2), one per newscast:
 * - a list `[{ title, discussionUrl, originalUrl }, ...]`: the first `article_limit` articles
 * - `{ articles: [...] }` (the picks of a form): every article, at most 10
 * - `{ url }`: the article at the URL
 * - `{ text, title? }`: the text itself, at most 24,000 characters; read verbatim when the
 *   `verbatim` setting is on
 */
export function parseNewscastSources(input: unknown, settings: NewscastSettings): NewscastSource[] {
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new TaskGroupInputError('The input is an empty list; there is no article to make a newscast of.');
    }
    const taken = input.slice(0, settings.articleLimit);
    return sourcesOfArticles(
      taken.map((item, index) => parseArticle(item, `Item ${index} of the input`)),
      settings.articleLimit,
    );
  }
  if (!isPlainObject(input)) {
    throw new TaskGroupInputError(`The input must be ${INPUT_SHAPES}.`);
  }

  const shapes = (['articles', 'url', 'text'] as const).filter((key) => input[key] !== undefined);
  if (shapes.length !== 1) {
    throw new TaskGroupInputError(
      shapes.length === 0
        ? `The input has no source; it must be ${INPUT_SHAPES}.`
        : `The input has ${shapes.map((key) => `'${key}'`).join(' and ')}; it must have one of them.`,
    );
  }

  switch (shapes[0]) {
    case 'articles': {
      if (!Array.isArray(input.articles)) {
        throw new TaskGroupInputError("The input field 'articles' must be a list.");
      }
      if (input.articles.length === 0) {
        throw new TaskGroupInputError("The input field 'articles' is empty; there is no article to make a newscast of.");
      }
      const taken = input.articles.slice(0, MAXIMUM_ARTICLE_LIMIT);
      return sourcesOfArticles(
        taken.map((item, index) => parseArticle(item, `Item ${index} of the input field 'articles'`)),
        MAXIMUM_ARTICLE_LIMIT,
      );
    }
    case 'url':
      return [{ kind: 'url', url: parseURL(input.url) }];
    case 'text':
      return [parseText(input, settings)];
  }
}

/**
 * Check the start request the scheduler sends (`TaskGroupStartRequest` of scheduler-manager-worker)
 * and turn it into the sources of the stage run.
 */
export function parseNewscastStart(request: unknown): NewscastStart {
  if (!isPlainObject(request)) {
    throw new TaskGroupInputError('The start request must be an object.');
  }
  const { stageRunID, userUUID } = request;
  if (typeof stageRunID !== 'string' || !UUID_PATTERN.test(stageRunID)) {
    throw new TaskGroupInputError('stageRunID must be a UUID.');
  }
  if (typeof userUUID !== 'string' || !LOWERCASE_UUID_PATTERN.test(userUUID)) {
    throw new TaskGroupInputError('userUUID must be a lowercase UUID.');
  }
  const settings = parseNewscastSettings(request.settings ?? {});
  return { stageRunID, userUUID, settings, sources: parseNewscastSources(request.input, settings) };
}

/** The title a newscast has before it is made: the article's, the URL, or the pasted text's. */
export function titleOfSource(source: NewscastSource): string {
  switch (source.kind) {
    case 'article':
      return source.entry.title;
    case 'url':
      return source.url;
    case 'text':
      return resolveCustomArticleTitle(source.customArticle);
  }
}

/**
 * The `request` of one newscast: its source and the settings of the stage, in the core
 * `JobRequestSnapshot` shape (see {@link NewscastRequest}).
 */
export function buildNewscastRequest(
  source: NewscastSource,
  settings: NewscastSettings,
  voices: { speaker1Voice: string; speaker2Voice: string },
): NewscastRequest {
  return {
    limit: 1,
    ...(source.kind === 'article' ? { entries: [source.entry] } : {}),
    ...(source.kind === 'url' ? { url: source.url } : {}),
    ...(source.kind === 'text' ? { customArticle: source.customArticle } : {}),
    provider: settings.provider,
    ...(settings.model !== undefined ? { model: settings.model } : {}),
    ...(settings.effort !== undefined ? { effort: settings.effort } : {}),
    lengthPreference: settings.lengthPreference,
    ttsModel: settings.ttsModel,
    speaker1Voice: voices.speaker1Voice,
    speaker2Voice: voices.speaker2Voice,
    signal: settings.signal,
  };
}
