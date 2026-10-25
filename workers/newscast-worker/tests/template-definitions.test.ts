import { describe, expect, it } from 'vitest';
import { DEFAULT_TTS_MODEL } from '@audio-underview/newscast-core';
import { buildNewscastTemplate, type TemplateStage } from '../sources/template-definitions.ts';
import { DEFAULT_ARTICLE_LIMIT } from '../sources/task-group-input.ts';
// The form check and the form resolution of the scheduler, which takes the stages of the templates
import { checkFormStageSettings } from '../../scheduler-manager-worker/sources/form-definition.ts';
import { resolveForm } from '../../scheduler-manager-worker/sources/form-resolution.ts';

// The stages of the three templates, as they are sent to the scheduler. The form check of the scheduler
// is stricter than the design, so every form is run through the check itself as well as pinned here.

const CRAWLER_ID = '00000000-0000-0000-0000-000000000099';
const SOURCES = ['geeknews', 'url', 'text'] as const;

const NEWSCAST_STAGE: TemplateStage = {
  role: 'newscast',
  request: {
    stage_type: 'task_group',
    task_group_id: 'newscast',
    task_group_version: 1,
    settings: {
      provider: 'google',
      model: '',
      effort: '',
      length: 'standard',
      tts_model: DEFAULT_TTS_MODEL,
      signal: false,
      verbatim: false,
      article_limit: DEFAULT_ARTICLE_LIMIT,
    },
  },
};

// What a crawl of geeknews-list gives the form
const ARTICLES = [
  { title: 'First', discussionUrl: 'https://news.hada.io/topic?id=1', originalUrl: 'https://a.example.com/1' },
  { title: 'Second', discussionUrl: 'https://news.hada.io/topic?id=2', originalUrl: 'https://a.example.com/2' },
];

// The keys of each object ordered as Postgres keeps them in JSONB: shorter first, then by bytes
function asJSONB(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(asJSONB);
  if (typeof value !== 'object' || value === null) return value;
  const keys = Object.keys(value).sort((left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(keys.map((key) => [key, asJSONB((value as Record<string, unknown>)[key])]));
}

function formStageOf(source: (typeof SOURCES)[number]): TemplateStage {
  const forms = buildNewscastTemplate(source, CRAWLER_ID).stages.filter((stage) => stage.role === 'form');
  expect(forms).toHaveLength(1);
  return forms[0];
}

describe('the stages of the templates', () => {
  it('makes the geeknews template of the crawler, the form that picks up to 10 articles, and the newscast group', () => {
    expect(buildNewscastTemplate('geeknews', CRAWLER_ID)).toEqual({
      name: 'Newscast from GeekNews',
      stages: [
        {
          role: 'crawler',
          request: { crawler_id: CRAWLER_ID, input_schema: { url: { type: 'string', default: 'https://news.hada.io/' } } },
        },
        {
          role: 'form',
          request: {
            stage_type: 'form',
            settings: {
              timeout_minutes: 30,
              form: {
                type: 'object',
                properties: {
                  articles: {
                    type: 'array',
                    title: 'Articles',
                    description: 'The articles to make a newscast of, one newscast each',
                    'x-widget': 'checkboxes',
                    'x-order': 0,
                    'x-options': { from: '$', label: 'title', description: 'originalUrl' },
                    minItems: 1,
                    maxItems: 10,
                  },
                },
                required: ['articles'],
              },
            },
          },
        },
        NEWSCAST_STAGE,
      ],
    });
  });

  it('makes the url template of the form of one required http(s) URL, and the newscast group', () => {
    expect(buildNewscastTemplate('url')).toEqual({
      name: 'Newscast from a URL',
      stages: [
        {
          role: 'form',
          request: {
            stage_type: 'form',
            settings: {
              timeout_minutes: 30,
              form: {
                type: 'object',
                properties: {
                  url: {
                    type: 'string',
                    title: 'Article URL',
                    description: 'The address of the article to make a newscast of',
                    'x-widget': 'text',
                    'x-order': 0,
                    format: 'uri',
                    maxLength: 2048,
                  },
                },
                required: ['url'],
              },
            },
          },
        },
        NEWSCAST_STAGE,
      ],
    });
  });

  it('makes the text template of the form of a title and then a required text, and the newscast group', () => {
    expect(buildNewscastTemplate('text')).toEqual({
      name: 'Newscast from text',
      stages: [
        {
          role: 'form',
          request: {
            stage_type: 'form',
            settings: {
              timeout_minutes: 30,
              form: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    title: 'Title',
                    description: 'The title of the newscast; leave empty to take it from the text',
                    'x-widget': 'text',
                    'x-order': 0,
                    maxLength: 200,
                  },
                  text: {
                    type: 'string',
                    title: 'Text',
                    description: 'The text to make a newscast of',
                    'x-widget': 'textarea',
                    'x-order': 1,
                    maxLength: 24_000,
                  },
                },
                required: ['text'],
              },
            },
          },
        },
        NEWSCAST_STAGE,
      ],
    });
  });

  it('refuses to make the geeknews template without the crawler', () => {
    expect(() => buildNewscastTemplate('geeknews')).toThrow('The geeknews template needs the ID of the geeknews-list crawler.');
  });
});

describe('the forms of the templates in the scheduler', () => {
  it.each(SOURCES)('passes the form check of the scheduler for the %s template', (source) => {
    const { settings } = formStageOf(source).request as { settings: { form: unknown } };

    expect(checkFormStageSettings(settings)).toEqual({ valid: true, settings: { form: settings.form, timeoutMinutes: 30 } });
  });

  it.each([
    ['geeknews', ['articles']],
    ['url', ['url']],
    ['text', ['title', 'text']],
  ] as const)('shows the fields of the %s form in the order of the template after the database reorders the keys', (source, names) => {
    const stored = asJSONB(formStageOf(source).request.settings);
    const check = checkFormStageSettings(stored);
    if (!check.valid) throw new Error(check.description);

    const resolution = resolveForm(check.settings.form, ARTICLES);

    expect(resolution.resolved && resolution.form.fields.map((field) => field.name)).toEqual(names);
  });
});
