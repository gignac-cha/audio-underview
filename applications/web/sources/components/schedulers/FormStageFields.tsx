import styled from '@emotion/styled';
import type { SchedulerStageRow } from '@audio-underview/supabase-connector';

const FieldGroup = styled.div`
  margin-bottom: 1rem;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const TextInput = styled.input`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const TextArea = styled.textarea`
  width: 100%;
  min-height: 220px;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  outline: none;
  resize: vertical;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const FieldHint = styled.p`
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.375rem 0 0 0;
`;

export const DEFAULT_FORM_TIMEOUT_MINUTES = 1440;
export const MAXIMUM_FORM_TIMEOUT_MINUTES = 525_600;

/** A form definition the server accepts, which a new form stage starts from */
const EXAMPLE_FORM_DEFINITION = {
  type: 'object',
  required: ['topic'],
  properties: {
    topic: { type: 'string', title: 'Topic', maxLength: 200, 'x-widget': 'text', 'x-order': 0 },
    tone: { type: 'string', title: 'Tone', enum: ['calm', 'bright'], 'x-widget': 'radio', 'x-order': 1 },
    notes: { type: 'string', title: 'Notes', description: 'Anything else to keep in mind', maxLength: 2000, 'x-widget': 'textarea', 'x-order': 2 },
  },
};

export interface FormStageValue {
  // The form definition as the person writes it
  formJSON: string;
  // Minutes as typed; empty leaves the timeout to the server default
  timeoutMinutes: string;
}

export type FormStageSettingsResult =
  | { ok: true; settings: { form: Record<string, unknown>; timeout_minutes?: number } }
  | { ok: false; error: string };

export const EMPTY_FORM_STAGE_VALUE: FormStageValue = {
  formJSON: JSON.stringify(EXAMPLE_FORM_DEFINITION, null, 2),
  timeoutMinutes: String(DEFAULT_FORM_TIMEOUT_MINUTES),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The fields filled with what the stage holds. A stage that stores no timeout shows the default it
 * runs with.
 */
export function formStageValueFromStage(stage: SchedulerStageRow): FormStageValue {
  const settings = stage.settings ?? {};
  return {
    formJSON: JSON.stringify(settings.form ?? {}, null, 2),
    timeoutMinutes: String(settings.timeout_minutes ?? DEFAULT_FORM_TIMEOUT_MINUTES),
  };
}

/**
 * The settings of a form stage the fields write. Only what can be told here is checked; the server
 * checks the form definition itself and answers with the reason when it refuses it.
 */
export function readFormStageSettings(value: FormStageValue): FormStageSettingsResult {
  let form: unknown;
  try {
    form = JSON.parse(value.formJSON);
  } catch {
    return { ok: false, error: 'Invalid JSON in form definition.' };
  }
  if (!isPlainObject(form)) {
    return { ok: false, error: 'Form definition must be a JSON object.' };
  }

  const timeoutText = value.timeoutMinutes.trim();
  if (timeoutText === '') {
    return { ok: true, settings: { form } };
  }
  const timeoutMinutes = Number(timeoutText);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > MAXIMUM_FORM_TIMEOUT_MINUTES) {
    return { ok: false, error: `Timeout must be a whole number of minutes from 1 to ${MAXIMUM_FORM_TIMEOUT_MINUTES}.` };
  }
  return { ok: true, settings: { form, timeout_minutes: timeoutMinutes } };
}

/**
 * The settings of a stage as the server runs them, which leave out a timeout the stage does not
 * store, so settings that only differ by that default are the same.
 */
export function normalizeFormStageSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return { ...settings, timeout_minutes: settings.timeout_minutes ?? DEFAULT_FORM_TIMEOUT_MINUTES };
}

interface FormStageFieldsProperties {
  value: FormStageValue;
  onChange: (value: FormStageValue) => void;
  disabled: boolean;
}

/**
 * The form a form stage asks of the person (as JSON) and how long it waits for the answer.
 */
export function FormStageFields({ value, onChange, disabled }: FormStageFieldsProperties) {
  return (
    <>
      <FieldGroup>
        <FieldLabel htmlFor="stage-form-definition">Form Definition</FieldLabel>
        <TextArea
          id="stage-form-definition"
          value={value.formJSON}
          onChange={(event) => onChange({ ...value, formJSON: event.target.value })}
          disabled={disabled}
          spellCheck={false}
          placeholder='{"type": "object", "properties": {}}'
          aria-describedby="stage-form-definition-hint"
        />
        <FieldHint id="stage-form-definition-hint">
          A JSON Schema of the answer, where each property is a field. x-widget picks how it is asked:
          checkboxes, radio, select, text, textarea, number or toggle. x-order sets its place in the form.
        </FieldHint>
      </FieldGroup>

      <FieldGroup>
        <FieldLabel htmlFor="stage-form-timeout">Timeout (minutes)</FieldLabel>
        <TextInput
          id="stage-form-timeout"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAXIMUM_FORM_TIMEOUT_MINUTES}
          step={1}
          placeholder={String(DEFAULT_FORM_TIMEOUT_MINUTES)}
          value={value.timeoutMinutes}
          onChange={(event) => onChange({ ...value, timeoutMinutes: event.target.value })}
          disabled={disabled}
          aria-describedby="stage-form-timeout-hint"
        />
        <FieldHint id="stage-form-timeout-hint">
          The run fails when nobody answers within this time. Leave it empty for {DEFAULT_FORM_TIMEOUT_MINUTES} (24 hours).
        </FieldHint>
      </FieldGroup>
    </>
  );
}
