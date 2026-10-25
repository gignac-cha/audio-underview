import { describe, expect, it } from 'vitest';
import { DEFAULT_TTS_MODEL } from '@audio-underview/newscast-core';
import { VERBATIM_LINE_CHARACTER_LIMIT } from '@audio-underview/newscast-script/verbatim-script.ts';
import {
  DEFAULT_ARTICLE_LIMIT,
  TaskGroupInputError,
  buildNewscastRequest,
  parseNewscastSettings,
  parseNewscastSources,
  parseNewscastStart,
  titleOfSource,
  type NewscastSettings,
} from '../sources/task-group-input.ts';

const USER_UUID = '11111111-1111-4111-8111-111111111111';
const STAGE_RUN_ID = '22222222-2222-4222-8222-222222222222';

function article(index: number) {
  return {
    title: `Article ${index}`,
    discussionUrl: `https://news.hada.io/topic?id=${index}`,
    originalUrl: `https://example.com/article-${index}`,
  };
}

const DEFAULT_SETTINGS: NewscastSettings = parseNewscastSettings({});

function inputError(run: () => unknown): TaskGroupInputError {
  try {
    run();
  } catch (error) {
    if (error instanceof TaskGroupInputError) return error;
    throw error;
  }
  throw new Error('Expected a TaskGroupInputError');
}

describe('parseNewscastSettings', () => {
  it('fills in the defaults of design §2 for an empty object', () => {
    expect(parseNewscastSettings({})).toEqual({
      provider: 'google',
      lengthPreference: 'standard',
      ttsModel: DEFAULT_TTS_MODEL,
      signal: false,
      verbatim: false,
      articleLimit: DEFAULT_ARTICLE_LIMIT,
    });
    expect(DEFAULT_ARTICLE_LIMIT).toBe(3);
  });

  it('reads every key of the settings schema', () => {
    expect(parseNewscastSettings({
      provider: 'anthropic',
      model: '  claude-model  ',
      effort: 'high',
      length: 'long',
      tts_model: 'gemini-3.8-flash-tts',
      signal: true,
      verbatim: true,
      article_limit: 10,
    })).toEqual({
      provider: 'anthropic',
      model: 'claude-model',
      effort: 'high',
      lengthPreference: 'long',
      ttsModel: 'gemini-3.8-flash-tts',
      signal: true,
      verbatim: true,
      articleLimit: 10,
    });
  });

  it('leaves the model and the effort out when they are empty', () => {
    const settings = parseNewscastSettings({ model: '   ', effort: '' });
    expect(settings).not.toHaveProperty('model');
    expect(settings).not.toHaveProperty('effort');
  });

  it.each([
    [{ provider: 'mistral' }, "Setting 'provider'"],
    [{ model: 3 }, "Setting 'model'"],
    [{ effort: 'extreme' }, "Setting 'effort'"],
    [{ length: 'medium' }, "Setting 'length'"],
    [{ tts_model: 'gemini-tts-unknown' }, "Setting 'tts_model'"],
    [{ signal: 'yes' }, "Setting 'signal'"],
    [{ verbatim: 1 }, "Setting 'verbatim'"],
    [{ article_limit: 0 }, "Setting 'article_limit'"],
    [{ article_limit: 11 }, "Setting 'article_limit'"],
    [{ article_limit: 2.5 }, "Setting 'article_limit'"],
  ])('refuses %j, naming the setting', (settings, expected) => {
    expect(inputError(() => parseNewscastSettings(settings)).message).toContain(expected);
  });

  it('refuses settings that are not an object', () => {
    expect(inputError(() => parseNewscastSettings([])).message).toBe('The settings must be an object.');
  });
});

describe('parseNewscastSources', () => {
  it('takes the first article_limit articles of a list (the geeknews-list output)', () => {
    const list = Array.from({ length: 30 }, (_value, index) => article(index));

    const sources = parseNewscastSources(list, DEFAULT_SETTINGS);

    expect(sources).toEqual([0, 1, 2].map((index) => ({ kind: 'article', entry: article(index) })));
    expect(parseNewscastSources(list, { ...DEFAULT_SETTINGS, articleLimit: 1 })).toHaveLength(1);
  });

  it('checks only the articles it takes, and trims them', () => {
    const list = [
      { title: '  First  ', discussionUrl: ' https://news.hada.io/topic?id=1 ', originalUrl: ' https://example.com/1 ' },
      { title: 'not taken' },
    ];

    expect(parseNewscastSources(list, { ...DEFAULT_SETTINGS, articleLimit: 1 })).toEqual([
      { kind: 'article', entry: { title: 'First', discussionUrl: 'https://news.hada.io/topic?id=1', originalUrl: 'https://example.com/1' } },
    ]);
  });

  it('accepts an article without a discussion page', () => {
    expect(parseNewscastSources([{ ...article(1), discussionUrl: '' }], DEFAULT_SETTINGS)).toEqual([
      { kind: 'article', entry: { ...article(1), discussionUrl: '' } },
    ]);
  });

  it('refuses an empty list and an item that is not an article', () => {
    expect(inputError(() => parseNewscastSources([], DEFAULT_SETTINGS)).message).toContain('empty list');
    expect(inputError(() => parseNewscastSources([article(0), { title: 'x' }], DEFAULT_SETTINGS)).message)
      .toContain('Item 1 of the input is not an article');
    expect(inputError(() => parseNewscastSources([{ ...article(0), title: ' ' }], DEFAULT_SETTINGS)).message)
      .toContain('Item 0 of the input is not an article');
  });

  it('takes every picked article of { articles }, at most 10, whatever article_limit says', () => {
    const picks = Array.from({ length: 12 }, (_value, index) => article(index));

    const sources = parseNewscastSources({ articles: picks }, { ...DEFAULT_SETTINGS, articleLimit: 1 });

    expect(sources).toHaveLength(10);
    expect(sources[9]).toEqual({ kind: 'article', entry: article(9) });
  });

  it('refuses { articles } that is not a non-empty list of articles', () => {
    expect(inputError(() => parseNewscastSources({ articles: 'one' }, DEFAULT_SETTINGS)).message).toContain("'articles' must be a list");
    expect(inputError(() => parseNewscastSources({ articles: [] }, DEFAULT_SETTINGS)).message).toContain("'articles' is empty");
    expect(inputError(() => parseNewscastSources({ articles: [{}] }, DEFAULT_SETTINGS)).message)
      .toContain("Item 0 of the input field 'articles' is not an article");
  });

  it('makes one source of { url }', () => {
    expect(parseNewscastSources({ url: ' https://example.com/post ' }, DEFAULT_SETTINGS)).toEqual([
      { kind: 'url', url: 'https://example.com/post' },
    ]);
  });

  it.each([
    [{ url: 42 }, "'url' must be a string"],
    [{ url: 'not a url' }, "'url' is not a URL"],
    [{ url: 'ftp://example.com/file' }, "'url' must be an http or https URL"],
  ])('refuses %j', (input, expected) => {
    expect(inputError(() => parseNewscastSources(input, DEFAULT_SETTINGS)).message).toContain(expected);
  });

  it('makes one source of { text, title? }, verbatim only when the setting says so', () => {
    expect(parseNewscastSources({ text: '  본문입니다.  ', title: '  제목  ' }, DEFAULT_SETTINGS)).toEqual([
      { kind: 'text', customArticle: { content: '본문입니다.', title: '제목' } },
    ]);
    expect(parseNewscastSources({ text: '화자1: 안녕하세요.' }, { ...DEFAULT_SETTINGS, verbatim: true })).toEqual([
      { kind: 'text', customArticle: { content: '화자1: 안녕하세요.', verbatim: true } },
    ]);
  });

  it('refuses a text that is empty, too long, or not readable verbatim', () => {
    expect(inputError(() => parseNewscastSources({ text: '   ' }, DEFAULT_SETTINGS)).message).toContain("'text' is empty");
    expect(inputError(() => parseNewscastSources({ text: 'a'.repeat(24_001) }, DEFAULT_SETTINGS)).message)
      .toContain('longer than 24,000 characters');
    // 24,000 characters is still accepted
    expect(parseNewscastSources({ text: 'a'.repeat(24_000) }, DEFAULT_SETTINGS)).toHaveLength(1);
    expect(inputError(() => parseNewscastSources({ text: '화자1:' }, { ...DEFAULT_SETTINGS, verbatim: true })).message)
      .toContain('no line to read verbatim');
    expect(inputError(() => parseNewscastSources(
      { text: `화자1: ${'가'.repeat(VERBATIM_LINE_CHARACTER_LIMIT + 1)}` },
      { ...DEFAULT_SETTINGS, verbatim: true },
    )).message).toContain('A line of the input field');
    expect(inputError(() => parseNewscastSources({ text: '본문', title: 3 }, DEFAULT_SETTINGS)).message).toContain("'title' must be a string");
  });

  it('refuses an object with no source, or with two of them', () => {
    // The input of a group that is the first stage of a scheduler
    expect(inputError(() => parseNewscastSources({}, DEFAULT_SETTINGS)).message).toContain('The input has no source');
    expect(inputError(() => parseNewscastSources({ url: 'https://example.com', text: '본문' }, DEFAULT_SETTINGS)).message)
      .toBe("The input has 'url' and 'text'; it must have one of them.");
  });

  it('refuses an input that is neither a list nor an object', () => {
    expect(inputError(() => parseNewscastSources('text', DEFAULT_SETTINGS)).message).toContain('The input must be');
    expect(inputError(() => parseNewscastSources(null, DEFAULT_SETTINGS)).message).toContain('The input must be');
  });
});

describe('parseNewscastStart', () => {
  const request = {
    stageRunID: STAGE_RUN_ID,
    taskGroupID: 'newscast',
    taskGroupVersion: 1,
    input: [article(0)],
    settings: {},
    userUUID: USER_UUID,
  };

  it('checks the request and returns its sources', () => {
    expect(parseNewscastStart(request)).toEqual({
      stageRunID: STAGE_RUN_ID,
      userUUID: USER_UUID,
      settings: DEFAULT_SETTINGS,
      sources: [{ kind: 'article', entry: article(0) }],
    });
  });

  it('refuses a user UUID the vault would refuse: not lowercase, or not a UUID', () => {
    expect(inputError(() => parseNewscastStart({ ...request, userUUID: 'AAAAAAAA-1111-4111-8111-111111111111' })).message)
      .toBe('userUUID must be a lowercase UUID.');
    expect(inputError(() => parseNewscastStart({ ...request, userUUID: 'user-1' })).message).toBe('userUUID must be a lowercase UUID.');
  });

  it('refuses a stage run ID that is not a UUID', () => {
    expect(inputError(() => parseNewscastStart({ ...request, stageRunID: 'run-1' })).message).toBe('stageRunID must be a UUID.');
  });
});

describe('titleOfSource and buildNewscastRequest', () => {
  const voices = { speaker1Voice: 'Charon', speaker2Voice: 'Leda' };

  it('titles an article by its title, a URL by itself, and a text by its first spoken line', () => {
    expect(titleOfSource({ kind: 'article', entry: article(3) })).toBe('Article 3');
    expect(titleOfSource({ kind: 'url', url: 'https://example.com/post' })).toBe('https://example.com/post');
    expect(titleOfSource({ kind: 'text', customArticle: { content: '화자1: 첫 문장.\n둘째' } })).toBe('첫 문장.');
  });

  it('builds the request in the core snapshot shape, with the url and the signal setting', () => {
    const settings = parseNewscastSettings({ provider: 'openai', model: 'gpt-model', effort: 'low', signal: true });

    expect(buildNewscastRequest({ kind: 'article', entry: article(1) }, settings, voices)).toEqual({
      limit: 1,
      entries: [article(1)],
      provider: 'openai',
      model: 'gpt-model',
      effort: 'low',
      lengthPreference: 'standard',
      ttsModel: DEFAULT_TTS_MODEL,
      speaker1Voice: 'Charon',
      speaker2Voice: 'Leda',
      signal: true,
    });
    expect(buildNewscastRequest({ kind: 'url', url: 'https://example.com/post' }, DEFAULT_SETTINGS, voices)).toEqual({
      limit: 1,
      url: 'https://example.com/post',
      provider: 'google',
      lengthPreference: 'standard',
      ttsModel: DEFAULT_TTS_MODEL,
      speaker1Voice: 'Charon',
      speaker2Voice: 'Leda',
      signal: false,
    });
    expect(buildNewscastRequest({ kind: 'text', customArticle: { content: '본문' } }, DEFAULT_SETTINGS, voices))
      .toMatchObject({ customArticle: { content: '본문' } });
  });
});
