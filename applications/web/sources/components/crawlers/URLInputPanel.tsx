import styled from '@emotion/styled';

const Container = styled.div`
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

const Input = styled('input', {
  shouldForwardProp: (prop) => prop !== 'isInvalid',
})<{ isInvalid: boolean }>`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid ${({ isInvalid }) => (isInvalid ? 'var(--color-error)' : 'var(--border-subtle)')};
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-family: var(--font-mono);
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

interface URLInputPanelProperties {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function isValidURL(value: string): boolean {
  if (!value) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function URLInputPanel({ value, onChange, disabled }: URLInputPanelProperties) {
  const isInvalid = value.length > 0 && !isValidURL(value);

  return (
    <Container>
      <Label>Target URL</Label>
      <Input
        type="url"
        placeholder="https://example.com"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        isInvalid={isInvalid}
      />
    </Container>
  );
}
