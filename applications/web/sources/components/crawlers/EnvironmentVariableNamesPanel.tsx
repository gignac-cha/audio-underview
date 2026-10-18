import { useId, useState } from 'react';
import styled from '@emotion/styled';
import { Link } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faXmark } from '@fortawesome/free-solid-svg-icons';
import { validateDeclaredEnvironmentVariableName } from '../../hooks/crawler-form-helpers.ts';
import { MAXIMUM_ENVIRONMENT_VARIABLES } from '../../schemas/environment-variable-rules.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Label = styled.label`
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
`;

const Names = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

const NameRow = styled.li`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.25rem 0.625rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
`;

const NameText = styled.span`
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  color: var(--text-primary);
  word-break: break-all;
`;

const Registration = styled('span', {
  shouldForwardProp: (prop) => prop !== 'isMissing',
})<{ isMissing: boolean }>`
  font-size: 0.75rem;
  color: ${({ isMissing }) => (isMissing ? '#f59e0b' : 'var(--color-success)')};

  a {
    margin-left: 0.375rem;
    color: var(--accent-primary);
  }
`;

const RemoveButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;

  &:hover {
    color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }
`;

const AddRow = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const NameInput = styled.input`
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0.375rem 0.625rem;
  outline: none;
  font-family: var(--font-mono);
  transition: border-color 120ms ease;

  &:focus {
    border-color: var(--border-focus);
  }
`;

const AddButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;

  &:hover {
    color: var(--text-primary);
    border-color: var(--border-focus);
  }
`;

const Helper = styled('span', {
  shouldForwardProp: (prop) => prop !== 'isError',
})<{ isError?: boolean }>`
  font-size: 0.75rem;
  color: ${({ isError }) => (isError ? 'var(--color-error)' : 'var(--text-muted)')};
`;

interface EnvironmentVariableNamesPanelProperties {
  names: string[];
  editable: boolean;
  onChange: (names: string[]) => void;
  // The names registered in the account; undefined while that is not known
  registeredNames: ReadonlySet<string> | undefined;
  // Why the registered names are not known, when the account's list could not be read
  registrationError: string | undefined;
}

export function EnvironmentVariableNamesPanel({
  names,
  editable,
  onChange,
  registeredNames,
  registrationError,
}: EnvironmentVariableNamesPanelProperties) {
  const identifier = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  const addName = () => {
    const name = draft.trim();
    const nameError = validateDeclaredEnvironmentVariableName(name, names);
    if (nameError) {
      setError(nameError);
      return;
    }
    onChange([...names, name]);
    setDraft('');
    setError(undefined);
  };

  return (
    <Container>
      {editable ? (
        <Label htmlFor={identifier}>Environment variables</Label>
      ) : (
        <Label as="span">Environment variables</Label>
      )}
      {names.length === 0 ? (
        <Helper>No environment variables declared.</Helper>
      ) : (
        <Names aria-label="Declared environment variables">
          {names.map((name) => (
            <NameRow key={name}>
              <NameText>{name}</NameText>
              {registeredNames !== undefined && (
                <Registration isMissing={!registeredNames.has(name)}>
                  {registeredNames.has(name) ? (
                    'Set'
                  ) : (
                    <>
                      Not set
                      {/* A new tab keeps the editor's unsaved code and declarations; a router link would skip the discard guard */}
                      <Link to="/settings" target="_blank" rel="noopener noreferrer" aria-label={`Set ${name} in Settings`}>
                        Settings
                      </Link>
                    </>
                  )}
                </Registration>
              )}
              {editable && (
                <RemoveButton
                  type="button"
                  onClick={() => onChange(names.filter((candidate) => candidate !== name))}
                  aria-label={`Remove ${name}`}
                >
                  <FontAwesomeIcon icon={faXmark} aria-hidden={true} />
                </RemoveButton>
              )}
            </NameRow>
          ))}
        </Names>
      )}
      {registrationError && names.length > 0 && (
        <Helper>Could not check which names are set: {registrationError}</Helper>
      )}
      {editable && (
        <>
          <AddRow>
            <NameInput
              id={identifier}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addName();
                }
              }}
              placeholder="API_TOKEN"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!error}
              aria-describedby={`${identifier}-helper`}
            />
            <AddButton type="button" onClick={addName} aria-label="Add environment variable name">
              <FontAwesomeIcon icon={faPlus} aria-hidden={true} />
              Add
            </AddButton>
          </AddRow>
          <Helper id={`${identifier}-helper`} isError={!!error} role={error ? 'alert' : undefined}>
            {error ??
              `Names this crawler reads from context.environment, up to ${MAXIMUM_ENVIRONMENT_VARIABLES}. Values are set in Settings.`}
          </Helper>
        </>
      )}
    </Container>
  );
}
