/**
 * The settings of a new newscast, as the New newscast panel edits them, and their shape in the
 * settings of the newscast task group stage (the keys of the group's settings schema).
 */

import {
  DEFAULT_TTS_MODEL,
  type LlmProvider,
  type NewscastLengthPreference,
} from '@audio-underview/newscast-core';
import { defaultModelForProvider, type ScriptEffort } from '@audio-underview/newscast-script';
import type { NewscastSource } from '../../schemas/newscast-schedulers.ts';

/** '' leaves the effort to the provider. */
export type SelectableEffort = '' | ScriptEffort;

export interface NewscastSettings {
  provider: LlmProvider;
  model: string;
  effort: SelectableEffort;
  length: NewscastLengthPreference;
  ttsModel: string;
  signal: boolean;
  /** Only sent for a pasted text. */
  verbatim: boolean;
}

/** Provider options in display order; Google is the default pick. */
export const PROVIDER_OPTIONS: readonly LlmProvider[] = ['google', 'anthropic', 'openai', 'xai'];

export const LENGTH_OPTIONS: { value: NewscastLengthPreference; label: string }[] = [
  { value: 'short', label: 'Short' },
  { value: 'standard', label: 'Standard' },
  { value: 'long', label: 'Long' },
];

export const DEFAULT_NEWSCAST_SETTINGS: NewscastSettings = {
  provider: 'google',
  model: defaultModelForProvider('google'),
  effort: '',
  length: 'standard',
  ttsModel: DEFAULT_TTS_MODEL,
  signal: false,
  verbatim: false,
};

/**
 * The settings object `PUT /schedulers/:id/stages/:stageID` stores on the newscast group stage.
 * The whole object replaces the stored one, so a key that is left out takes the group's default.
 */
export function taskGroupSettingsFor(settings: NewscastSettings, source: NewscastSource): Record<string, unknown> {
  return {
    provider: settings.provider,
    model: settings.model,
    effort: settings.effort,
    length: settings.length,
    tts_model: settings.ttsModel,
    signal: settings.signal,
    ...(source === 'text' ? { verbatim: settings.verbatim } : {}),
  };
}
