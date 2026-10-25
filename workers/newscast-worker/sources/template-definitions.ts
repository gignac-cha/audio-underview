/**
 * The three newscast templates: the scheduler a user gets for each source of articles, with its stages.
 *
 * Every template ends in the same two stages, a form that waits for the articles and the newscast task
 * group that makes a newscast of each. The answer of the form is the input of the group, so each form is
 * shaped like one of the inputs the group takes (`task-group-input.ts`):
 *
 *   geeknews  the system crawler `geeknews-list`, then a form that picks articles of its list
 *             -> { articles: [{ title, discussionUrl, originalUrl }, ...] }
 *   url       a form for the address of an article                 -> { url }
 *   text      a form for the text of an article and its title      -> { text, title? }
 *
 * A form stage keeps its form definition in `settings.form`: a JSON Schema of the answer, in which a field
 * says how it is drawn with `x-widget`, where its choices come from with `x-options` and its place in the
 * form with `x-order` (see the design of the form stage). A scheduler made from a template has no schedule
 * and is turned off: the user starts it.
 */

import { DEFAULT_TTS_MODEL } from '@audio-underview/newscast-core';
import { DEFAULT_ARTICLE_LIMIT } from './task-group-input.ts';
import type { NewscastTemplateSource } from './newscast-schedulers.ts';

/** The system crawler whose list the geeknews template picks articles from. */
export const GEEKNEWS_LIST_CRAWLER_NAME = 'geeknews-list';

/** The task group the last stage of every template runs, in its registered version. */
export const NEWSCAST_TASK_GROUP_ID = 'newscast';
export const NEWSCAST_TASK_GROUP_VERSION = 1;

/** How long a form waits for its answer. */
const FORM_TIMEOUT_MINUTES = 30;

const GEEKNEWS_LIST_URL = 'https://news.hada.io/';

/** The most articles the geeknews form lets a user pick: the most newscasts one stage run makes. */
const MAXIMUM_PICKED_ARTICLES = 10;
const MAXIMUM_URL_LENGTH = 2048;
const MAXIMUM_TITLE_LENGTH = 200;
const MAXIMUM_TEXT_LENGTH = 24_000;

/**
 * The settings of the newscast stage of a template: the default of every setting of the registered task
 * group (migration 016), so the stage shows the settings it runs with. The web screen replaces them with
 * the choices of the user before it starts the run.
 */
const NEWSCAST_STAGE_SETTINGS = {
  provider: 'google',
  model: '',
  effort: '',
  length: 'standard',
  tts_model: DEFAULT_TTS_MODEL,
  signal: false,
  verbatim: false,
  article_limit: DEFAULT_ARTICLE_LIMIT,
};

/**
 * What a stage of a template is for, so the ones the caller needs back can be found among the IDs the
 * scheduler gave: the form the user answers and the stage the settings go to.
 */
export type TemplateStageRole = 'crawler' | 'form' | 'newscast';

export interface TemplateStage {
  role: TemplateStageRole;
  /** The body of `POST /schedulers/:id/stages`, without `stage_order` */
  request: Record<string, unknown>;
}

export interface NewscastTemplate {
  /** The name of the scheduler */
  name: string;
  stages: TemplateStage[];
}

function formStage(form: Record<string, unknown>): TemplateStage {
  return {
    role: 'form',
    request: { stage_type: 'form', settings: { form, timeout_minutes: FORM_TIMEOUT_MINUTES } },
  };
}

function newscastStage(): TemplateStage {
  return {
    role: 'newscast',
    request: {
      stage_type: 'task_group',
      task_group_id: NEWSCAST_TASK_GROUP_ID,
      task_group_version: NEWSCAST_TASK_GROUP_VERSION,
      settings: { ...NEWSCAST_STAGE_SETTINGS },
    },
  };
}

/**
 * The template of a source.
 *
 * @param geeknewsListCrawlerID - the ID of the system crawler `geeknews-list`; the geeknews template needs it
 */
export function buildNewscastTemplate(
  source: NewscastTemplateSource,
  geeknewsListCrawlerID?: string,
): NewscastTemplate {
  switch (source) {
    case 'geeknews': {
      if (geeknewsListCrawlerID === undefined) {
        throw new Error('The geeknews template needs the ID of the geeknews-list crawler.');
      }
      return {
        name: 'Newscast from GeekNews',
        stages: [
          {
            role: 'crawler',
            request: {
              crawler_id: geeknewsListCrawlerID,
              input_schema: { url: { type: 'string', default: GEEKNEWS_LIST_URL } },
            },
          },
          formStage({
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
                maxItems: MAXIMUM_PICKED_ARTICLES,
              },
            },
            required: ['articles'],
          }),
          newscastStage(),
        ],
      };
    }
    case 'url':
      return {
        name: 'Newscast from a URL',
        stages: [
          formStage({
            type: 'object',
            properties: {
              url: {
                type: 'string',
                title: 'Article URL',
                description: 'The address of the article to make a newscast of',
                'x-widget': 'text',
                'x-order': 0,
                format: 'uri',
                maxLength: MAXIMUM_URL_LENGTH,
              },
            },
            required: ['url'],
          }),
          newscastStage(),
        ],
      };
    case 'text':
      return {
        name: 'Newscast from text',
        stages: [
          formStage({
            type: 'object',
            properties: {
              title: {
                type: 'string',
                title: 'Title',
                description: 'The title of the newscast; leave empty to take it from the text',
                'x-widget': 'text',
                'x-order': 0,
                maxLength: MAXIMUM_TITLE_LENGTH,
              },
              text: {
                type: 'string',
                title: 'Text',
                description: 'The text to make a newscast of',
                'x-widget': 'textarea',
                'x-order': 1,
                maxLength: MAXIMUM_TEXT_LENGTH,
              },
            },
            required: ['text'],
          }),
          newscastStage(),
        ],
      };
  }
}
