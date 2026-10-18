import { useId, useState, type FormEvent } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate, faEye, faEyeSlash, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useToast } from '../../hooks/use-toast.ts';
import {
  useDeleteEnvironmentVariable,
  useListEnvironmentVariables,
  useSetEnvironmentVariable,
} from '../../hooks/use-environment-variables.ts';
import {
  MAXIMUM_ENVIRONMENT_VARIABLES,
  validateEnvironmentVariableName,
  validateEnvironmentVariableValue,
} from '../../schemas/environment-variable-rules.ts';
import { DiscardDialog } from '../DiscardDialog.tsx';

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
`;

const SectionTitle = styled.h2`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const Count = styled.span`
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
`;

const Description = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.5;
`;

const AddForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const FieldRow = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto;
  align-items: end;
  gap: 0.75rem;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
`;

const FieldLabel = styled.label`
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
`;

const TextInput = styled.input`
  width: 100%;
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.5rem 0.625rem;
  outline: none;
  font-family: var(--font-mono);
  transition: border-color 120ms ease;

  &:focus {
    border-color: var(--border-focus);
  }
`;

const ValueWrapper = styled.div`
  position: relative;
  display: flex;

  input {
    padding-right: 2.25rem;
  }
`;

const ToggleButton = styled.button`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 2.25rem;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  cursor: pointer;

  &:hover {
    color: var(--text-primary);
  }
`;

const PrimaryButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: pointer;
  transition: opacity 120ms ease;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const GhostButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;

  &:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-deep);
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const FormError = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-error);
`;

const Table = styled.div`
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
`;

const COLUMNS = 'minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr) auto';

const HeaderRow = styled.div`
  display: grid;
  grid-template-columns: ${COLUMNS};
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;

  @media (max-width: 700px) {
    display: none;
  }
`;

const Row = styled.div`
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
`;

const RowSummary = styled.div`
  display: grid;
  grid-template-columns: ${COLUMNS};
  align-items: center;
  gap: 0.75rem;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
    gap: 0.25rem;
  }
`;

const VariableName = styled.span`
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  color: var(--text-primary);
  word-break: break-all;
`;

const Timestamp = styled.span`
  font-size: 0.75rem;
  color: var(--text-secondary);
`;

// The column headers are hidden on a narrow screen, so each time names itself there
const MobileLabel = styled.span`
  display: none;
  color: var(--text-muted);

  @media (max-width: 700px) {
    display: inline;
  }
`;

const RowActions = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const DangerButton = styled(GhostButton)`
  &:hover:not(:disabled) {
    color: var(--color-error);
    border-color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }
`;

const ChangeForm = styled.form`
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
  margin-top: 0.75rem;

  > div {
    flex: 1;
  }
`;

const Message = styled.p`
  margin: 0;
  padding: 1.5rem 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-muted);
`;

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface RowError {
  name: string;
  message: string;
}

export function EnvironmentVariablesSection() {
  const identifier = useId();
  const { showToast } = useToast();
  const { environmentVariables, isLoading, isLoaded, error, refetch } = useListEnvironmentVariables();
  const { setEnvironmentVariable, status: setStatus } = useSetEnvironmentVariable();
  const { deleteEnvironmentVariable } = useDeleteEnvironmentVariable();

  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [isValueVisible, setIsValueVisible] = useState(false);
  const [addError, setAddError] = useState<string>();

  const [changingName, setChangingName] = useState<string>();
  const [changeValue, setChangeValue] = useState('');
  const [rowError, setRowError] = useState<RowError>();

  const [deleteTarget, setDeleteTarget] = useState<string>();

  const isSaving = setStatus === 'pending';
  // The duplicate and limit checks read the list, and the server replaces a value of an existing
  // name without a word, so nothing is added before the list is known
  const canAdd = isLoaded && !isSaving;

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    if (!canAdd) return;

    const trimmedName = name.trim();
    const nameError = validateEnvironmentVariableName(trimmedName);
    if (nameError) {
      setAddError(nameError);
      return;
    }
    if (environmentVariables.some((variable) => variable.name === trimmedName)) {
      setAddError(`${trimmedName} already exists. Use "Change value" on its row to update it.`);
      return;
    }
    if (environmentVariables.length >= MAXIMUM_ENVIRONMENT_VARIABLES) {
      setAddError(`At most ${MAXIMUM_ENVIRONMENT_VARIABLES} environment variables are allowed.`);
      return;
    }
    const valueError = validateEnvironmentVariableValue(value);
    if (valueError) {
      setAddError(valueError);
      return;
    }

    // The value leaves the page with the request; nothing here keeps it
    const submittedValue = value;
    setValue('');
    setAddError(undefined);
    try {
      const { replaced } = await setEnvironmentVariable({ name: trimmedName, value: submittedValue });
      setName('');
      // The list was stale (the name was added elsewhere in the meantime), so say what really happened
      showToast(
        'Saved',
        replaced
          ? `${trimmedName} already existed, so its value has been replaced.`
          : `${trimmedName} has been added.`,
        replaced ? 'info' : 'success',
      );
    } catch (requestError) {
      setAddError(requestError instanceof Error ? requestError.message : 'Failed to save the environment variable');
    }
  };

  const startChange = (variableName: string) => {
    setChangingName(variableName);
    setChangeValue('');
    setRowError(undefined);
  };

  const cancelChange = () => {
    setChangingName(undefined);
    setChangeValue('');
    setRowError(undefined);
  };

  const handleChange = async (event: FormEvent, variableName: string) => {
    event.preventDefault();
    if (isSaving) return;

    const valueError = validateEnvironmentVariableValue(changeValue);
    if (valueError) {
      setRowError({ name: variableName, message: valueError });
      return;
    }

    const submittedValue = changeValue;
    setChangeValue('');
    setRowError(undefined);
    try {
      await setEnvironmentVariable({ name: variableName, value: submittedValue });
      setChangingName(undefined);
      showToast('Saved', `${variableName} has been changed.`, 'success');
    } catch (requestError) {
      setRowError({
        name: variableName,
        message: requestError instanceof Error ? requestError.message : 'Failed to save the environment variable',
      });
    }
  };

  const handleDelete = async () => {
    const variableName = deleteTarget;
    if (variableName === undefined) return;
    setDeleteTarget(undefined);
    setRowError(undefined);
    try {
      await deleteEnvironmentVariable(variableName);
      if (changingName === variableName) cancelChange();
      showToast('Deleted', `${variableName} has been deleted.`, 'success');
    } catch (requestError) {
      setRowError({
        name: variableName,
        message: requestError instanceof Error ? requestError.message : 'Failed to delete the environment variable',
      });
    }
  };

  return (
    <Section aria-labelledby={`${identifier}-title`}>
      <SectionHeader>
        <SectionTitle id={`${identifier}-title`}>Environment variables</SectionTitle>
        {!isLoading && !error && (
          <Count aria-label={`${environmentVariables.length} of ${MAXIMUM_ENVIRONMENT_VARIABLES} used`}>
            {environmentVariables.length} / {MAXIMUM_ENVIRONMENT_VARIABLES}
          </Count>
        )}
      </SectionHeader>
      <Description>
        Values are stored for your account and never shown again. A crawler receives only the variables whose names it
        declares, in context.environment.
      </Description>

      <AddForm onSubmit={handleAdd} noValidate aria-label="Add an environment variable">
        <FieldRow>
          <Field>
            <FieldLabel htmlFor={`${identifier}-name`}>Name</FieldLabel>
            <TextInput
              id={`${identifier}-name`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setAddError(undefined);
              }}
              placeholder="API_TOKEN"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${identifier}-value`}>Value</FieldLabel>
            <ValueWrapper>
              <TextInput
                id={`${identifier}-value`}
                type={isValueVisible ? 'text' : 'password'}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setAddError(undefined);
                }}
                spellCheck={false}
                autoComplete="new-password"
              />
              <ToggleButton
                type="button"
                onClick={() => setIsValueVisible((previous) => !previous)}
                aria-label={isValueVisible ? 'Hide value' : 'Show value'}
                aria-pressed={isValueVisible}
              >
                <FontAwesomeIcon icon={isValueVisible ? faEyeSlash : faEye} aria-hidden={true} />
              </ToggleButton>
            </ValueWrapper>
          </Field>
          <PrimaryButton type="submit" disabled={!canAdd}>
            Add
          </PrimaryButton>
        </FieldRow>
        {addError && <FormError role="alert">{addError}</FormError>}
      </AddForm>

      {isLoading ? (
        <Message role="status">Loading environment variables...</Message>
      ) : error ? (
        <>
          <Message role="alert">Failed to load environment variables: {error.message}</Message>
          <div>
            <GhostButton type="button" onClick={() => refetch()}>
              <FontAwesomeIcon icon={faArrowsRotate} aria-hidden={true} />
              Retry
            </GhostButton>
          </div>
        </>
      ) : environmentVariables.length === 0 ? (
        <Message>No environment variables yet.</Message>
      ) : (
        <Table>
          <HeaderRow aria-hidden="true">
            <span>Name</span>
            <span>Created</span>
            <span>Changed</span>
            <span />
          </HeaderRow>
          {environmentVariables.map((variable) => (
            <Row key={variable.name}>
              <RowSummary>
                <VariableName>{variable.name}</VariableName>
                <Timestamp>
                  <MobileLabel>Created </MobileLabel>
                  {formatDateTime(variable.created_at)}
                </Timestamp>
                <Timestamp>
                  <MobileLabel>Changed </MobileLabel>
                  {formatDateTime(variable.updated_at)}
                </Timestamp>
                <RowActions>
                  <GhostButton
                    type="button"
                    onClick={() => startChange(variable.name)}
                    aria-label={`Change value of ${variable.name}`}
                  >
                    Change value
                  </GhostButton>
                  <DangerButton
                    type="button"
                    onClick={() => setDeleteTarget(variable.name)}
                    aria-label={`Delete ${variable.name}`}
                  >
                    <FontAwesomeIcon icon={faTrash} aria-hidden={true} />
                    Delete
                  </DangerButton>
                </RowActions>
              </RowSummary>
              {changingName === variable.name && (
                <ChangeForm onSubmit={(event) => handleChange(event, variable.name)} noValidate>
                  <Field>
                    <FieldLabel htmlFor={`${identifier}-change-${variable.name}`}>New value</FieldLabel>
                    <TextInput
                      id={`${identifier}-change-${variable.name}`}
                      type="password"
                      value={changeValue}
                      onChange={(event) => {
                        setChangeValue(event.target.value);
                        setRowError(undefined);
                      }}
                      spellCheck={false}
                      autoComplete="new-password"
                      autoFocus
                    />
                  </Field>
                  <PrimaryButton type="submit" disabled={isSaving}>
                    Save
                  </PrimaryButton>
                  <GhostButton type="button" onClick={cancelChange}>
                    Cancel
                  </GhostButton>
                </ChangeForm>
              )}
              {rowError?.name === variable.name && (
                <FormError role="alert" style={{ marginTop: '0.5rem' }}>
                  {rowError.message}
                </FormError>
              )}
            </Row>
          ))}
        </Table>
      )}

      <DiscardDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={handleDelete}
        title={`Delete ${deleteTarget ?? ''}?`}
        description="Crawlers that declare this name will no longer receive it. This cannot be undone."
        confirmLabel="Delete"
        keepLabel="Cancel"
      />
    </Section>
  );
}
