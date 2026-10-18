import { useId } from 'react';
import styled from '@emotion/styled';
import { useToast } from '../../hooks/use-toast.ts';
import {
  formatOptionLabel,
  startEditingSettingsJSON,
  stopEditingSettingsJSON,
  type SettingsEditorState,
  type SettingsField,
} from './task-group-settings.ts';

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

const CheckboxRow = styled.label`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-secondary);

  input[type='checkbox'] {
    accent-color: var(--accent-primary);
    width: 16px;
    height: 16px;
  }
`;

const FieldHint = styled.p`
  font-size: 0.75rem;
  color: var(--text-muted);
  margin: 0.375rem 0 0 0;
`;

const ToggleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
`;

const ToggleLink = styled.button`
  font-size: 0.75rem;
  color: var(--accent-primary);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;

  &:hover {
    text-decoration: underline;
  }
`;

interface SettingFieldInputProperties {
  field: SettingsField;
  inputID: string;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
  disabled: boolean;
}

function SettingFieldInput({ field, inputID, value, onChange, disabled }: SettingFieldInputProperties) {
  const hintID = `${inputID}-hint`;
  const describedBy = field.description === undefined ? undefined : hintID;
  const requiredMark = field.required && <RequiredMark> (required)</RequiredMark>;
  const text = typeof value === 'string' ? value : '';

  if (field.kind === 'boolean') {
    return (
      <FieldGroup>
        <CheckboxRow>
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
            aria-describedby={describedBy}
          />
          {field.label}
          {requiredMark}
        </CheckboxRow>
        {field.description !== undefined && <FieldHint id={hintID}>{field.description}</FieldHint>}
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <FieldLabel htmlFor={inputID}>
        {field.label}
        {requiredMark}
      </FieldLabel>
      {field.kind === 'select' ? (
        <Select
          id={inputID}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        >
          <option value="">Select a value...</option>
          {field.options.map((option) => (
            <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
              {formatOptionLabel(option)}
            </option>
          ))}
        </Select>
      ) : field.kind === 'json' ? (
        <TextArea
          id={inputID}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          spellCheck={false}
          placeholder="JSON"
          aria-describedby={describedBy}
        />
      ) : (
        <TextInput
          id={inputID}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-describedby={describedBy}
        />
      )}
      {field.description !== undefined && <FieldHint id={hintID}>{field.description}</FieldHint>}
    </FieldGroup>
  );
}

interface TaskGroupSettingsFieldsProperties {
  // Undefined for a format without fields, whose settings are written as one JSON object
  fields: SettingsField[] | undefined;
  state: SettingsEditorState;
  onChange: (state: SettingsEditorState) => void;
  disabled: boolean;
}

/**
 * The settings of a task group stage: a field for each property of the group's settings format,
 * or the whole settings as JSON.
 */
export function TaskGroupSettingsFields({ fields, state, onChange, disabled }: TaskGroupSettingsFieldsProperties) {
  const { showToast } = useToast();
  const idPrefix = useId();
  const jsonID = `${idPrefix}-settings`;
  const isShowingJSON = fields === undefined || state.isEditingJSON;

  const handleToggle = () => {
    if (fields === undefined) return;
    const result = state.isEditingJSON ? stopEditingSettingsJSON(fields, state) : startEditingSettingsJSON(fields, state);
    if (!result.ok) {
      showToast('Validation Error', result.error, 'error');
      return;
    }
    onChange(result.state);
  };

  return (
    <FieldGroup>
      <ToggleRow>
        <FieldLabel htmlFor={isShowingJSON ? jsonID : undefined} style={{ marginBottom: 0 }}>Settings</FieldLabel>
        {fields !== undefined && (
          <ToggleLink type="button" onClick={handleToggle}>
            {state.isEditingJSON ? 'Simple mode' : 'Edit JSON'}
          </ToggleLink>
        )}
      </ToggleRow>
      {isShowingJSON ? (
        <TextArea
          id={jsonID}
          value={state.settingsJSON}
          onChange={(event) => onChange({ ...state, settingsJSON: event.target.value })}
          disabled={disabled}
          spellCheck={false}
          placeholder='{"key": "value"}'
        />
      ) : fields.length === 0 ? (
        <FieldHint>This version has no settings.</FieldHint>
      ) : (
        fields.map((field, index) => (
          <SettingFieldInput
            key={field.name}
            field={field}
            inputID={`${idPrefix}-setting-${index}`}
            value={state.inputValues[field.name]}
            onChange={(value) => onChange({ ...state, inputValues: { ...state.inputValues, [field.name]: value } })}
            disabled={disabled}
          />
        ))
      )}
    </FieldGroup>
  );
}
