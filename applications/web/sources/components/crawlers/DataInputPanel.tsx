import { useId } from 'react';
import styled from '@emotion/styled';

const Container = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Label = styled.label`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const Area = styled('textarea', {
  shouldForwardProp: (prop) => prop !== 'isInvalid',
})<{ isInvalid: boolean }>`
  width: 100%;
  min-height: 96px;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid ${({ isInvalid }) => (isInvalid ? 'var(--color-error)' : 'var(--border-subtle)')};
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.8125rem;
  font-family: var(--font-mono);
  resize: vertical;
  outline: none;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: ${({ isInvalid }) => (isInvalid ? 'var(--color-error)' : 'var(--border-focus)')};
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const Helper = styled('span', {
  shouldForwardProp: (prop) => prop !== 'isError',
})<{ isError: boolean }>`
  font-size: 0.75rem;
  color: ${({ isError }) => (isError ? 'var(--color-error)' : 'var(--text-muted)')};
`;

interface DataInputPanelProperties {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}

export function DataInputPanel({ value, onChange, error, disabled }: DataInputPanelProperties) {
  const identifier = useId();
  const helperIdentifier = `${identifier}-helper`;

  return (
    <Container>
      <Label htmlFor={identifier}>Input (JSON)</Label>
      <Area
        id={identifier}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder='{"key": "value"}'
        spellCheck={false}
        disabled={disabled}
        isInvalid={!!error}
        aria-invalid={!!error}
        aria-describedby={helperIdentifier}
      />
      <Helper id={helperIdentifier} isError={!!error} role={error ? 'alert' : undefined}>
        {error ?? 'Leave empty to use the default input built from the input schema.'}
      </Helper>
    </Container>
  );
}
