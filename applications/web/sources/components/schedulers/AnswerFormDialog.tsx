import { useId, useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Dialog from '@radix-ui/react-dialog';
import type { SchedulerFormField, SchedulerStageRunForm } from '@audio-underview/supabase-connector';
import { useToast } from '../../hooks/use-toast.ts';
import {
  readStageRunForm,
  useAnswerStageRun,
  useCancelStageRun,
  useGetStageRun,
  type StageRunSummary,
} from '../../hooks/use-scheduler-runs.ts';
import {
  createAnswerValues,
  readAnswer,
  type AnswerFieldValue,
  type AnswerValues,
} from './answer-form.ts';

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90vw;
  max-width: 520px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-md);
`;

const Title = styled(Dialog.Title)`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 1rem 0;
`;

const Description = styled(Dialog.Description)`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

const FieldGroup = styled.div`
  margin-bottom: 1rem;
`;

const Fieldset = styled.fieldset`
  min-width: 0;
  margin: 0 0 1rem 0;
  padding: 0;
  border: none;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const Legend = styled.legend`
  padding: 0;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const RequiredMark = styled.span`
  font-weight: 400;
  color: var(--text-muted);
`;

const Select = styled.select`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &:focus {
    border-color: var(--border-focus);
  }

  option {
    background: var(--bg-deep);
    color: var(--text-primary);
  }
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
  min-height: 120px;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-family: inherit;
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

const ChoiceRow = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.25rem 0;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-secondary);

  input {
    accent-color: var(--accent-primary);
    width: 16px;
    height: 16px;
    margin: 0.125rem 0 0 0;
    flex-shrink: 0;
  }
`;

const ChoiceText = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-wrap: anywhere;
`;

const ChoiceDescription = styled.span`
  font-size: 0.75rem;
  color: var(--text-muted);
`;

const FieldHint = styled.p`
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.375rem 0 0 0;
`;

const ErrorHint = styled(FieldHint)`
  color: var(--color-error);
`;

const StatusMessage = styled.p`
  font-size: 0.875rem;
  color: var(--text-muted);
  margin: 0;
`;

const ErrorMessage = styled.p`
  font-size: 0.8125rem;
  color: var(--color-error);
  margin: 1rem 0 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

const ButtonRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1.5rem;
`;

const ButtonGroup = styled.div`
  display: flex;
  gap: 0.75rem;
`;

const CancelButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-deep);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const CancelRunButton = styled(CancelButton)`
  color: var(--color-error);

  &:hover:not(:disabled) {
    color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Spinner = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const SubmitButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'isSubmitting',
})<{ isSubmitting?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: ${({ isSubmitting }) => (isSubmitting ? 'not-allowed' : 'pointer')};
  opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 1)};
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 0.9)};
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

function formatExpiry(expiresAt: string): string {
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return expiresAt;
  return expiry.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function describeSelectedCount(field: SchedulerFormField, selectedCount: number): string {
  const count = field.maxItems === undefined ? `${selectedCount} selected` : `${selectedCount} / ${field.maxItems} selected`;
  return field.minItems !== undefined && field.minItems > 0 ? `${count} · at least ${field.minItems}` : count;
}

interface AnswerFieldInputProperties {
  field: SchedulerFormField;
  inputID: string;
  value: AnswerFieldValue | undefined;
  // Why the value cannot be sent, when it is filled but wrong
  problem: string | undefined;
  onChange: (value: AnswerFieldValue) => void;
  disabled: boolean;
}

/**
 * One field of the form, asked the way its widget says. Every label and description is text, whatever
 * characters it holds.
 */
function AnswerFieldInput({ field, inputID, value, problem, onChange, disabled }: AnswerFieldInputProperties) {
  const hintID = `${inputID}-hint`;
  const describedBy = field.description === undefined ? undefined : hintID;
  const label = field.title ?? field.name;
  const requiredMark = field.required && <RequiredMark> (required)</RequiredMark>;
  const hint = field.description !== undefined && <FieldHint id={hintID}>{field.description}</FieldHint>;
  const problemHint = problem !== undefined && <ErrorHint>{problem}</ErrorHint>;
  const text = typeof value === 'string' ? value : '';
  const choices = field.choices ?? [];

  if (field.widget === 'checkboxes') {
    const selected = Array.isArray(value) ? value : [];
    const isAtMaximum = field.maxItems !== undefined && selected.length >= field.maxItems;
    return (
      <Fieldset aria-describedby={describedBy}>
        <Legend>
          {label}
          {requiredMark}
        </Legend>
        {choices.map((choice, index) => {
          const isChecked = selected.includes(index);
          return (
            <ChoiceRow key={index}>
              <input
                type="checkbox"
                checked={isChecked}
                // At the maximum the unchecked boxes wait until one is unchecked
                disabled={disabled || (isAtMaximum && !isChecked)}
                onChange={(event) => {
                  onChange(event.target.checked ? [...selected, index] : selected.filter((chosen) => chosen !== index));
                }}
              />
              <ChoiceText>
                {choice.label}
                {choice.description !== undefined && <ChoiceDescription>{choice.description}</ChoiceDescription>}
              </ChoiceText>
            </ChoiceRow>
          );
        })}
        <FieldHint>{describeSelectedCount(field, selected.length)}</FieldHint>
        {hint}
        {problemHint}
      </Fieldset>
    );
  }

  if (field.widget === 'radio') {
    return (
      <Fieldset aria-describedby={describedBy}>
        <Legend>
          {label}
          {requiredMark}
        </Legend>
        {choices.map((choice, index) => (
          <ChoiceRow key={index}>
            <input
              type="radio"
              name={inputID}
              checked={text === String(index)}
              disabled={disabled}
              onChange={() => onChange(String(index))}
            />
            <ChoiceText>
              {choice.label}
              {choice.description !== undefined && <ChoiceDescription>{choice.description}</ChoiceDescription>}
            </ChoiceText>
          </ChoiceRow>
        ))}
        {hint}
        {problemHint}
      </Fieldset>
    );
  }

  if (field.widget === 'toggle') {
    return (
      <FieldGroup>
        <ChoiceRow>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
            aria-describedby={describedBy}
          />
          <ChoiceText>
            <span>
              {label}
              {requiredMark}
            </span>
          </ChoiceText>
        </ChoiceRow>
        {hint}
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <FieldLabel htmlFor={inputID}>
        {label}
        {requiredMark}
      </FieldLabel>
      {field.widget === 'select' ? (
        <Select
          id={inputID}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        >
          <option value="">Select an option...</option>
          {choices.map((choice, index) => (
            <option key={index} value={String(index)}>{choice.label}</option>
          ))}
        </Select>
      ) : field.widget === 'textarea' ? (
        <TextArea
          id={inputID}
          value={text}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        />
      ) : field.widget === 'number' ? (
        <TextInput
          id={inputID}
          type="number"
          inputMode="decimal"
          min={field.minimum}
          max={field.maximum}
          step="any"
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        />
      ) : (
        <TextInput
          id={inputID}
          type="text"
          maxLength={field.maxLength}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        />
      )}
      {hint}
      {problemHint}
    </FieldGroup>
  );
}

interface AnswerFormBodyProperties {
  form: SchedulerStageRunForm;
  isSending: boolean;
  isCancelling: boolean;
  // What the server said about the last try
  errorMessage: string | undefined;
  onSend: (answer: Record<string, unknown>) => void;
  onCancelRun: () => void;
}

function AnswerFormBody({ form, isSending, isCancelling, errorMessage, onSend, onCancelRun }: AnswerFormBodyProperties) {
  const idPrefix = useId();
  const [values, setValues] = useState<AnswerValues>(() => createAnswerValues(form.fields));
  const isBusy = isSending || isCancelling;
  const reading = readAnswer(form.fields, values, form.schema);

  const handleSubmit = () => {
    if (isBusy || !reading.isComplete) return;
    onSend(reading.answer);
  };

  return (
    <form noValidate onSubmit={(event) => { event.preventDefault(); handleSubmit(); }}>
      {form.fields.map((field, index) => (
        <AnswerFieldInput
          key={field.name}
          field={field}
          inputID={`${idPrefix}-field-${index}`}
          value={values.get(field.name)}
          problem={reading.problems.get(field.name)}
          onChange={(value) => setValues(new Map(values).set(field.name, value))}
          disabled={isBusy}
        />
      ))}
      <AnswerButtons
        isSending={isSending}
        isCancelling={isCancelling}
        canSend={reading.isComplete}
        errorMessage={errorMessage}
        onCancelRun={onCancelRun}
      />
    </form>
  );
}

interface AnswerButtonsProperties {
  isSending: boolean;
  isCancelling: boolean;
  // Undefined where there is no form to send
  canSend?: boolean;
  errorMessage: string | undefined;
  onCancelRun: () => void;
}

function AnswerButtons({ isSending, isCancelling, canSend, errorMessage, onCancelRun }: AnswerButtonsProperties) {
  const isBusy = isSending || isCancelling;
  return (
    <>
      {errorMessage !== undefined && <ErrorMessage role="alert">{errorMessage}</ErrorMessage>}
      <ButtonRow>
        <CancelRunButton type="button" onClick={onCancelRun} disabled={isBusy}>
          {isCancelling ? 'Cancelling...' : 'Cancel run'}
        </CancelRunButton>
        <ButtonGroup>
          <Dialog.Close asChild>
            <CancelButton type="button" disabled={isBusy}>Close</CancelButton>
          </Dialog.Close>
          {canSend !== undefined && (
            <SubmitButton type="submit" disabled={isBusy || !canSend} isSubmitting={isSending}>
              {isSending && <Spinner />}
              {isSending ? 'Sending...' : 'Send answer'}
            </SubmitButton>
          )}
        </ButtonGroup>
      </ButtonRow>
    </>
  );
}

interface AnswerFormDialogProperties {
  schedulerID: string;
  runID: string;
  // The form stage run that waits, as the run lists it
  stageRun: StageRunSummary;
  onOpenChange: (open: boolean) => void;
}

/**
 * The form a form stage run waits for, asked field by field, and the answer sent to the server.
 * The run can be cancelled from here instead, which ends it as failed.
 */
export function AnswerFormDialog({ schedulerID, runID, stageRun, onOpenChange }: AnswerFormDialogProperties) {
  const { showToast } = useToast();
  // The same read as the open stage run detail has, so it is in the cache already when the row is open
  const { stageRun: detail, isLoading, error: loadError } = useGetStageRun(schedulerID, runID, stageRun.id, false);
  const { answerStageRun, status: answerStatus, error: answerError, reset: resetAnswer } = useAnswerStageRun();
  const { cancelStageRun, status: cancelStatus, error: cancelError, reset: resetCancel } = useCancelStageRun();

  const isSending = answerStatus === 'pending';
  const isCancelling = cancelStatus === 'pending';
  const isBusy = isSending || isCancelling;
  const form = detail === undefined ? undefined : readStageRunForm(detail.form);
  const errorMessage = answerError?.message ?? cancelError?.message;
  const input = { scheduler_id: schedulerID, run_id: runID, stage_run_id: stageRun.id };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isBusy) return;
    onOpenChange(nextOpen);
  };

  const handleSend = async (answer: Record<string, unknown>) => {
    resetCancel();
    try {
      await answerStageRun({ ...input, answer });
    } catch {
      // The reason the server gives shows in the dialog, which stays open for another try
      return;
    }
    showToast('Success', 'Answer sent.', 'success');
    onOpenChange(false);
  };

  const handleCancelRun = async () => {
    resetAnswer();
    try {
      await cancelStageRun(input);
    } catch {
      return;
    }
    showToast('Success', 'Run cancelled.', 'success');
    onOpenChange(false);
  };

  return (
    <Dialog.Root open onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Title>Answer</Title>
          <Description>
            {form === undefined
              ? 'This run is waiting for your answer.'
              : `This run is waiting for your answer. It fails if nobody answers by ${formatExpiry(form.expires_at)}.`}
          </Description>

          {form !== undefined ? (
            <AnswerFormBody
              form={form}
              isSending={isSending}
              isCancelling={isCancelling}
              errorMessage={errorMessage}
              onSend={handleSend}
              onCancelRun={handleCancelRun}
            />
          ) : (
            <>
              <StatusMessage>
                {isLoading
                  ? 'Loading...'
                  : loadError
                    ? `Failed to load the form: ${loadError.message}`
                    : 'The form of this stage cannot be shown.'}
              </StatusMessage>
              <AnswerButtons
                isSending={isSending}
                isCancelling={isCancelling}
                errorMessage={errorMessage}
                onCancelRun={handleCancelRun}
              />
            </>
          )}
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
