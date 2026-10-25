/**
 * The "New newscast" panel: the source (GeekNews, a URL, or a pasted text), the settings of the
 * newscast group stage, and the start. A newscast is made by the template scheduler of its source
 * (see `use-new-newscast.ts`): a URL or a text answers the form with what was typed here, and
 * GeekNews shows the articles of its form to pick from once the list is fetched.
 *
 * Every newscast is voiced with the user's own Google key, so a missing Google key blocks the
 * start; the script is written with the key of the picked provider, which is only pointed out.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faFileLines,
  faKey,
  faLink,
  faNewspaper,
  faWandMagicSparkles,
} from '@fortawesome/free-solid-svg-icons';
import { TTS_MODELS, type LlmProvider } from '@audio-underview/newscast-core';
import {
  MODELS_BY_PROVIDER,
  defaultModelForProvider,
  effortsForModel,
} from '@audio-underview/newscast-script';
import { useProviderKeys } from '../../hooks/use-provider-keys.ts';
import type { NewNewscast } from '../../hooks/use-new-newscast.ts';
import { PROVIDER_LABELS } from '../../schemas/provider-keys.ts';
import type { NewscastSource } from '../../schemas/newscast-schedulers.ts';
import { ArticleChoicePicker } from './ArticleChoicePicker.tsx';
import { isHTTPURL } from './http-url.ts';
import {
  DEFAULT_NEWSCAST_SETTINGS,
  LENGTH_OPTIONS,
  PROVIDER_OPTIONS,
  taskGroupSettingsFor,
  type NewscastSettings,
  type SelectableEffort,
} from './newscast-settings.ts';

/** The caps of the template forms, checked here first so a mistake shows before the start. */
const MAXIMUM_URL_LENGTH = 2048;
const MAXIMUM_TITLE_LENGTH = 200;
const MAXIMUM_TEXT_LENGTH = 24_000;

const SOURCE_TABS: { value: NewscastSource; label: string; icon: typeof faNewspaper }[] = [
  { value: 'geeknews', label: 'GeekNews', icon: faNewspaper },
  { value: 'url', label: 'URL', icon: faLink },
  { value: 'text', label: 'Text', icon: faFileLines },
];

/** TTS models split into the two select groups, in catalog order. */
const CURRENT_TTS_MODELS = TTS_MODELS.filter((option) => option.legacy !== true);
const LEGACY_TTS_MODELS = TTS_MODELS.filter((option) => option.legacy === true);

const Card = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  padding: 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
`;

/** Segmented control container shared by the source tabs and the length choice. */
const Segmented = styled.div`
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const SegmentButton = styled.button<{ active: boolean }>`
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  font-size: 0.78125rem;
  font-weight: 600;
  padding: 0.4rem 0.5rem;
  border-radius: 8px;
  cursor: pointer;
  transition: var(--transition-fast);
  color: ${(props) => (props.active ? 'var(--text-primary)' : 'var(--text-secondary)')};
  background: ${(props) => (props.active ? 'var(--accent-muted)' : 'transparent')};
  border: 1px solid ${(props) => (props.active ? 'var(--border-focus)' : 'transparent')};

  &:hover:not(:disabled) {
    color: var(--text-primary);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
`;

const SourceFields = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
`;

const Message = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--text-muted);
`;

const Field = styled.label`
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.71875rem;
  font-weight: 600;
  color: var(--text-secondary);
`;

const TextInput = styled.input`
  font-family: inherit;
  font-size: 0.8125rem;
  padding: 0.45rem 0.625rem;
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  min-width: 0;

  &:focus-visible {
    outline: 2px solid var(--border-focus);
  }
`;

const ContentArea = styled.textarea<{ over: boolean }>`
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.6;
  min-height: 9rem;
  resize: vertical;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid ${(props) => (props.over ? 'var(--color-error)' : 'var(--border-subtle)')};
  min-width: 0;

  &:focus-visible {
    outline: 2px solid ${(props) => (props.over ? 'var(--color-error)' : 'var(--border-focus)')};
  }
`;

/** Live "N / 24,000" character count; turns red once the cap is exceeded. */
const CharacterCounter = styled.span<{ over: boolean }>`
  align-self: flex-end;
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: ${(props) => (props.over ? 'var(--color-error)' : 'var(--text-muted)')};
`;

const InputError = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-error);
`;

/** A real checkbox in a label row, so it is announced and toggled by keyboard. */
const ToggleRow = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-deep);
  cursor: pointer;
`;

const ToggleCheckbox = styled.input`
  margin-top: 0.2rem;
  accent-color: var(--accent-primary);
  cursor: pointer;
`;

const ToggleText = styled.span`
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
`;

const ToggleTitle = styled.span`
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--text-primary);
`;

const ToggleDescription = styled.span`
  font-size: 0.71875rem;
  line-height: 1.6;
  color: var(--text-secondary);
`;

const SelectRow = styled.div`
  display: grid;
  /* min(9rem, 100%) keeps the auto-fit grid's INTRINSIC width at one column —
     a bare minmax(9rem, 1fr) makes the grid's min-content width equal to ALL
     columns side by side, which forces the page wider than a phone viewport. */
  grid-template-columns: repeat(auto-fit, minmax(min(9rem, 100%), 1fr));
  gap: 0.625rem;
`;

const Select = styled.select`
  font-family: inherit;
  font-size: 0.8125rem;
  padding: 0.45rem 0.625rem;
  border-radius: 8px;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  /* A select's intrinsic width is its longest <option>; never let that widen
     the layout past its grid cell. */
  min-width: 0;
  max-width: 100%;

  &:focus-visible {
    outline: 2px solid var(--border-focus);
  }
`;

/** The key guidance banner; the warning tone is for the missing Google key, which blocks the start. */
const GuidanceNote = styled('div', {
  shouldForwardProp: (prop) => prop !== 'warning',
})<{ warning?: boolean }>`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.625rem;
  padding: 0.75rem 1rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--text-primary);
  background: ${({ warning }) => (warning ? 'rgba(234, 179, 8, 0.1)' : 'rgba(99, 102, 241, 0.08)')};
  border: 1px solid ${({ warning }) => (warning ? 'rgba(234, 179, 8, 0.35)' : 'rgba(99, 102, 241, 0.25)')};
  border-radius: 10px;

  svg {
    flex-shrink: 0;
    color: ${({ warning }) => (warning ? 'rgb(234, 179, 8)' : 'var(--accent-primary)')};
  }
`;

const GuidanceText = styled.span`
  flex: 1;
  min-width: 12rem;
`;

const GuidanceButton = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 700;
  background: var(--accent-primary);
  color: #ffffff;
  cursor: pointer;
  transition: var(--transition-fast);
  white-space: nowrap;

  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
`;

const SecondaryButton = styled.button`
  flex-shrink: 0;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    border-color: var(--border-focus);
  }
`;

const ErrorNote = styled.p`
  margin: 0;
  padding: 0.75rem 1rem;
  font-size: 0.8125rem;
  color: var(--color-error);
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  border-radius: 10px;
  overflow-wrap: anywhere;
`;

const StartButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 700;
  padding: 0.7rem 1rem;
  border-radius: 10px;
  color: var(--text-primary);
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }
`;

interface NewNewscastPanelProps {
  newNewscast: NewNewscast;
  /** Called once a cancel went through, for the page's notice. */
  onCancelled?: () => void;
}

export function NewNewscastPanel({ newNewscast, onCancelled }: NewNewscastPanelProps) {
  const navigate = useNavigate();
  const { step, error, start, answerChoices, cancel, dismiss } = newNewscast;
  const { providerKeys, isLoaded: areProviderKeysLoaded } = useProviderKeys();

  const [source, setSource] = useState<NewscastSource>('geeknews');
  const [settings, setSettings] = useState<NewscastSettings>(DEFAULT_NEWSCAST_SETTINGS);
  const [url, setURL] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  // While the status of the keys is unknown, nothing is blocked: the newscast reports a missing key itself
  const isKeyMissing = (provider: LlmProvider) =>
    areProviderKeysLoaded && !providerKeys.some((key) => key.provider === provider && key.configured);
  const isGoogleKeyMissing = isKeyMissing('google');
  const isScriptKeyMissing = settings.provider !== 'google' && isKeyMissing(settings.provider);

  const modelOptions = MODELS_BY_PROVIDER[settings.provider];
  // Current ids and legacy ids render as two <optgroup>s so the divider between
  // them is a native group boundary, not a disabled placeholder <option>.
  const currentModelOptions = modelOptions.filter((option) => option.legacy !== true);
  const legacyModelOptions = modelOptions.filter((option) => option.legacy === true);
  // Effort levels the SELECTED model actually accepts (Gemini tops out at high; some models have none)
  const supportedEfforts = effortsForModel(settings.provider, settings.model);

  const trimmedURL = url.trim();
  const isURLValid = trimmedURL.length > 0 && trimmedURL.length <= MAXIMUM_URL_LENGTH && isHTTPURL(trimmedURL);
  const trimmedText = text.trim();
  const isTextOverCap = text.length > MAXIMUM_TEXT_LENGTH;
  const isSourceReady =
    source === 'geeknews' ||
    (source === 'url' && isURLValid) ||
    (source === 'text' && trimmedText.length > 0 && !isTextOverCap);

  const isFlowActive =
    step.kind === 'starting' ||
    step.kind === 'waiting-for-form' ||
    step.kind === 'answering' ||
    step.kind === 'choosing' ||
    (step.kind === 'busy' && step.isCancelling);
  const canStart = isSourceReady && !isGoogleKeyMissing && !isFlowActive;

  const updateSettings = (change: Partial<NewscastSettings>) => {
    setSettings((previous) => {
      const next = { ...previous, ...change };
      // A kept effort the new model does not take falls back to the provider's default
      if (next.effort !== '' && !effortsForModel(next.provider, next.model).includes(next.effort)) {
        next.effort = '';
      }
      return next;
    });
  };

  const handleProviderChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const provider = event.target.value as LlmProvider;
    updateSettings({ provider, model: defaultModelForProvider(provider) });
  };

  const handleStart = () => {
    if (!canStart) {
      return;
    }
    const answer =
      source === 'url'
        ? { url: trimmedURL }
        : source === 'text'
          ? { text: trimmedText, ...(title.trim().length > 0 ? { title: title.trim() } : {}) }
          : undefined;
    void start({ source, settings: taskGroupSettingsFor(settings, source), answer });
  };

  const handleCancel = () => {
    void cancel().then((cancelled) => {
      if (cancelled) {
        onCancelled?.();
      }
    });
  };

  const startLabel =
    step.kind === 'starting'
      ? 'Starting…'
      : step.kind === 'waiting-for-form'
        ? source === 'geeknews'
          ? 'Fetching GeekNews articles…'
          : 'Waiting for the form…'
        : step.kind === 'answering'
          ? 'Sending…'
          : source === 'geeknews'
            ? 'Pick GeekNews articles'
            : 'Make newscast';

  return (
    <Card>
      {isGoogleKeyMissing && (
        <GuidanceNote warning role="alert">
          <FontAwesomeIcon icon={faKey} aria-hidden={true} />
          <GuidanceText>
            Newscasts are voiced with your Google key. Register a Google key in Settings to start one.
          </GuidanceText>
          <GuidanceButton type="button" onClick={() => navigate('/settings')}>
            Go to Settings
          </GuidanceButton>
        </GuidanceNote>
      )}

      <Segmented role="tablist" aria-label="Newscast source">
        {SOURCE_TABS.map((tab) => (
          <SegmentButton
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={source === tab.value}
            active={source === tab.value}
            disabled={isFlowActive}
            onClick={() => setSource(tab.value)}
          >
            <FontAwesomeIcon icon={tab.icon} aria-hidden={true} />
            {tab.label}
          </SegmentButton>
        ))}
      </Segmented>

      {step.kind === 'choosing' ? (
        <ArticleChoicePicker
          form={step.openForm.form}
          isBusy={step.isAnswering}
          onAnswer={(indices) => void answerChoices(indices)}
          onCancel={handleCancel}
        />
      ) : (
        <>
          <SourceFields>
            {source === 'geeknews' && (
              <Message>
                The front page of GeekNews is fetched first, then you pick up to 10 articles. Each picked article
                becomes its own newscast.
              </Message>
            )}
            {source === 'url' && (
              <>
                <Field>
                  Article URL
                  <TextInput
                    type="url"
                    value={url}
                    maxLength={MAXIMUM_URL_LENGTH}
                    placeholder="https://"
                    onChange={(event) => setURL(event.target.value)}
                  />
                </Field>
                {trimmedURL.length > 0 && !isURLValid && <InputError>Enter an http or https URL.</InputError>}
              </>
            )}
            {source === 'text' && (
              <>
                <Field>
                  Title (optional)
                  <TextInput
                    type="text"
                    value={title}
                    maxLength={MAXIMUM_TITLE_LENGTH}
                    placeholder="Leave empty to use the first line"
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Field>
                <Field>
                  Text
                  <ContentArea
                    value={text}
                    over={isTextOverCap}
                    placeholder={settings.verbatim ? 'Paste the script, one line per turn' : 'Paste the article'}
                    onChange={(event) => setText(event.target.value)}
                  />
                </Field>
                <CharacterCounter over={isTextOverCap}>
                  {text.length.toLocaleString('en-US')} / {MAXIMUM_TEXT_LENGTH.toLocaleString('en-US')}
                </CharacterCounter>
                {isTextOverCap && (
                  <InputError role="alert">
                    The text is longer than {MAXIMUM_TEXT_LENGTH.toLocaleString('en-US')} characters. Shorten it.
                  </InputError>
                )}
                <ToggleRow>
                  <ToggleCheckbox
                    type="checkbox"
                    checked={settings.verbatim}
                    onChange={(event) => updateSettings({ verbatim: event.target.checked })}
                  />
                  <ToggleText>
                    <ToggleTitle>Read verbatim</ToggleTitle>
                    <ToggleDescription>
                      Read the text as the script instead of writing one. Each line is one turn; start a line with
                      Speaker1: or Speaker2: to pick the host.
                    </ToggleDescription>
                  </ToggleText>
                </ToggleRow>
              </>
            )}
          </SourceFields>

          <SelectRow>
            <Field>
              Provider
              <Select value={settings.provider} onChange={handleProviderChange}>
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider} value={provider}>
                    {PROVIDER_LABELS[provider]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              Model
              <Select value={settings.model} onChange={(event) => updateSettings({ model: event.target.value })}>
                <optgroup label="Current">
                  {currentModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                {legacyModelOptions.length > 0 && (
                  <optgroup label="Legacy">
                    {legacyModelOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            </Field>
            <Field>
              Effort
              <Select
                value={settings.effort}
                onChange={(event) => updateSettings({ effort: event.target.value as SelectableEffort })}
                disabled={supportedEfforts.length === 0}
                title={supportedEfforts.length === 0 ? 'This model has no effort control' : undefined}
              >
                <option value="">Default</option>
                {supportedEfforts.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              TTS
              <Select value={settings.ttsModel} onChange={(event) => updateSettings({ ttsModel: event.target.value })}>
                <optgroup label="Current">
                  {CURRENT_TTS_MODELS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Legacy">
                  {LEGACY_TTS_MODELS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </Field>
          </SelectRow>

          {isScriptKeyMissing && (
            <GuidanceNote role="note">
              <FontAwesomeIcon icon={faKey} aria-hidden={true} />
              <GuidanceText>
                The script is written with your {PROVIDER_LABELS[settings.provider]} key, which is not registered.
                Without it the newscast fails.
              </GuidanceText>
              <GuidanceButton type="button" onClick={() => navigate('/settings')}>
                Go to Settings
              </GuidanceButton>
            </GuidanceNote>
          )}

          <Field as="div">
            Length
            <Segmented role="group" aria-label="Length">
              {LENGTH_OPTIONS.map((option) => (
                <SegmentButton
                  key={option.value}
                  type="button"
                  aria-pressed={settings.length === option.value}
                  active={settings.length === option.value}
                  onClick={() => updateSettings({ length: option.value })}
                >
                  {option.label}
                </SegmentButton>
              ))}
            </Segmented>
          </Field>

          <ToggleRow>
            <ToggleCheckbox
              type="checkbox"
              checked={settings.signal}
              onChange={(event) => updateSettings({ signal: event.target.checked })}
            />
            <ToggleText>
              <ToggleTitle>Signal between parts</ToggleTitle>
              <ToggleDescription>
                Play a short generated signal between the parts of a newscast that has two or more parts.
              </ToggleDescription>
            </ToggleText>
          </ToggleRow>

          <StartButton type="button" onClick={handleStart} disabled={!canStart}>
            <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden={true} />
            {startLabel}
          </StartButton>
        </>
      )}

      {step.kind === 'busy' && (
        <GuidanceNote warning role="alert">
          <GuidanceText>
            {step.waitingForm !== undefined
              ? 'A newscast from this source is waiting for an answer. Cancel it to start a new one.'
              : 'A newscast from this source is still in progress. Start a new one once it ends.'}
          </GuidanceText>
          {step.waitingForm !== undefined && (
            <GuidanceButton type="button" onClick={handleCancel} disabled={step.isCancelling}>
              {step.isCancelling ? 'Cancelling…' : 'Cancel'}
            </GuidanceButton>
          )}
          <SecondaryButton type="button" onClick={dismiss}>
            Dismiss
          </SecondaryButton>
        </GuidanceNote>
      )}

      {step.kind === 'making' && (
        <Message role="status">The newscast is being made. It shows up in the list below.</Message>
      )}

      {error !== undefined && <ErrorNote role="alert">{error}</ErrorNote>}
    </Card>
  );
}
