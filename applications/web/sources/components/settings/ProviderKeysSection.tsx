import { useId, useState, type FormEvent } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate, faEye, faEyeSlash, faTrash } from '@fortawesome/free-solid-svg-icons';
import { useToast } from '../../hooks/use-toast.ts';
import { useDeleteProviderKey, useProviderKeys, useSetProviderKey } from '../../hooks/use-provider-keys.ts';
import { PROVIDER_LABELS, PROVIDER_NAMES, validateProviderKey, type ProviderKeyStatus, type ProviderName } from '../../schemas/provider-keys.ts';
import { VisuallyHidden } from '../../design-system/components/VisuallyHidden.tsx';
import { DiscardDialog } from '../DiscardDialog.tsx';

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const SectionTitle = styled.h2`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const Description = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.5;
`;

const Notes = styled.ul`
  margin: 0;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  line-height: 1.5;
`;

const Table = styled.div`
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
`;

const Row = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid var(--border-subtle);

  &:last-child {
    border-bottom: none;
  }
`;

const RowSummary = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
`;

const RowIdentity = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
`;

const RowTitle = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const ProviderTitle = styled.h3`
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
`;

const StatusBadge = styled('span', {
  shouldForwardProp: (property) => property !== 'configured',
})<{ configured: boolean }>`
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  color: ${({ configured }) => (configured ? 'var(--color-success)' : 'var(--text-muted)')};
  background: ${({ configured }) => (configured ? 'rgba(34, 197, 94, 0.12)' : 'var(--bg-deep)')};
`;

const Details = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
`;

const Last4 = styled.span`
  font-family: var(--font-mono);
  color: var(--text-primary);
`;

const KeyForm = styled.form`
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;

  > div {
    flex: 1;
  }

  @media (max-width: 700px) {
    flex-direction: column;
    align-items: stretch;
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

const ValueWrapper = styled.div`
  position: relative;
  display: flex;

  input {
    padding-right: 2.25rem;
  }
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
  transition:
    color 120ms ease,
    background 120ms ease,
    border-color 120ms ease;

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

const DangerButton = styled(GhostButton)`
  flex-shrink: 0;

  &:hover:not(:disabled) {
    color: var(--color-error);
    border-color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }
`;

const FormError = styled.p`
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-error);
`;

const Message = styled.p`
  margin: 0;
  padding: 1.5rem 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-muted);
`;

const Hint = styled.p`
  margin: 0;
  font-size: 0.8125rem;
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

function unconfiguredStatus(provider: ProviderName): ProviderKeyStatus {
  return { provider, configured: false, last4: null, validated_at: null };
}

export function ProviderKeysSection() {
  const identifier = useId();
  const { showToast } = useToast();
  const { providerKeys, isLoading, error, refetch } = useProviderKeys();
  const { setProviderKey, pendingProviders } = useSetProviderKey();
  const { deleteProviderKey, deletingProvider } = useDeleteProviderKey();

  // What is being typed for each provider; a key leaves this the moment it is submitted
  const [keyValues, setKeyValues] = useState<Partial<Record<ProviderName, string>>>({});
  const [visibleProviders, setVisibleProviders] = useState<ProviderName[]>([]);
  const [rowErrors, setRowErrors] = useState<Partial<Record<ProviderName, string>>>({});
  const [deleteTarget, setDeleteTarget] = useState<ProviderName>();

  const setRowError = (provider: ProviderName, message: string | undefined) => {
    setRowErrors((previous) => ({ ...previous, [provider]: message }));
  };

  const changeKeyValue = (provider: ProviderName, value: string) => {
    setKeyValues((previous) => ({ ...previous, [provider]: value }));
    setRowError(provider, undefined);
  };

  const toggleKeyVisible = (provider: ProviderName) => {
    setVisibleProviders((previous) => (previous.includes(provider) ? previous.filter((visible) => visible !== provider) : [...previous, provider]));
  };

  // The rows are drawn only from a loaded list, and the server answers every provider; a missing one reads as not set
  const statuses = PROVIDER_NAMES.map((provider) => providerKeys.find((status) => status.provider === provider) ?? unconfiguredStatus(provider));
  const hasAnyKey = statuses.some((status) => status.configured);

  const handleSubmit = async (event: FormEvent, status: ProviderKeyStatus) => {
    event.preventDefault();
    const { provider } = status;
    if (pendingProviders.includes(provider) || deletingProvider === provider) return;

    // A key never holds a space, so the spaces and line breaks that come along with a paste are dropped
    const key = (keyValues[provider] ?? '').trim();
    const keyError = validateProviderKey(key);
    if (keyError) {
      setRowError(provider, keyError);
      return;
    }

    // The key leaves the page with the request; nothing here keeps it
    changeKeyValue(provider, '');
    setVisibleProviders((previous) => previous.filter((visible) => visible !== provider));
    const label = PROVIDER_LABELS[provider];
    try {
      await setProviderKey({ provider, key });
      showToast('Saved', status.configured ? `The ${label} key has been replaced.` : `The ${label} key has been registered.`, 'success');
    } catch (requestError) {
      setRowError(provider, requestError instanceof Error ? requestError.message : 'Failed to save the key');
    }
  };

  const handleDelete = async () => {
    const provider = deleteTarget;
    if (provider === undefined) return;
    setDeleteTarget(undefined);
    setRowError(provider, undefined);
    try {
      await deleteProviderKey(provider);
      showToast('Removed', `The ${PROVIDER_LABELS[provider]} key has been removed.`, 'success');
    } catch (requestError) {
      setRowError(provider, requestError instanceof Error ? requestError.message : 'Failed to remove the key');
    }
  };

  return (
    <Section aria-labelledby={`${identifier}-title`}>
      <SectionTitle id={`${identifier}-title`}>Provider keys</SectionTitle>
      <Description>Newscasts call AI providers with your own keys. Register a key for each provider you want to use.</Description>
      <Notes>
        <li>Keys are encrypted before they are stored and are never displayed again. Only the last four characters stay visible.</li>
        <li>Set a usage limit for each key with the provider, so that a key cannot spend more than you expect.</li>
        <li>Newscast audio (TTS) always uses your Google key, whichever provider writes the script.</li>
      </Notes>

      {isLoading ? (
        <Message role="status">Loading provider keys...</Message>
      ) : error ? (
        <>
          <Message role="alert">Failed to load provider keys: {error.message}</Message>
          <div>
            <GhostButton type="button" onClick={() => refetch()} aria-label="Retry loading provider keys">
              <FontAwesomeIcon icon={faArrowsRotate} aria-hidden={true} />
              Retry
            </GhostButton>
          </div>
        </>
      ) : (
        <>
          {!hasAnyKey && <Hint>No provider keys yet. Every newscast needs a Google key for its audio, so start there.</Hint>}
          <Table>
            {statuses.map((status) => {
              const { provider } = status;
              const label = PROVIDER_LABELS[provider];
              const titleIdentifier = `${identifier}-${provider}-title`;
              const inputIdentifier = `${identifier}-${provider}-key`;
              const isKeyVisible = visibleProviders.includes(provider);
              const isSaving = pendingProviders.includes(provider);
              const isDeleting = deletingProvider === provider;
              const rowError = rowErrors[provider];
              return (
                <Row key={provider} role="group" aria-labelledby={titleIdentifier}>
                  <RowSummary>
                    <RowIdentity>
                      <RowTitle>
                        <ProviderTitle id={titleIdentifier}>{label}</ProviderTitle>
                        <StatusBadge configured={status.configured}>{status.configured ? 'Configured' : 'Not set'}</StatusBadge>
                      </RowTitle>
                      {status.configured && (
                        <Details>
                          {status.last4 !== null && (
                            <Last4>
                              <VisuallyHidden>Key ending in </VisuallyHidden>
                              <span aria-hidden="true">•••• </span>
                              {status.last4}
                            </Last4>
                          )}
                          {status.validated_at !== null && (
                            <span>
                              Checked <time dateTime={status.validated_at}>{formatDateTime(status.validated_at)}</time>
                            </span>
                          )}
                        </Details>
                      )}
                    </RowIdentity>
                    {status.configured && (
                      <DangerButton
                        type="button"
                        onClick={() => setDeleteTarget(provider)}
                        disabled={isSaving || isDeleting}
                        aria-label={`Remove ${label} key`}
                      >
                        <FontAwesomeIcon icon={faTrash} aria-hidden={true} />
                        Remove
                      </DangerButton>
                    )}
                  </RowSummary>
                  <KeyForm onSubmit={(event) => handleSubmit(event, status)} noValidate>
                    <Field>
                      <FieldLabel htmlFor={inputIdentifier}>{status.configured ? `New ${label} API key` : `${label} API key`}</FieldLabel>
                      <ValueWrapper>
                        <TextInput
                          id={inputIdentifier}
                          type={isKeyVisible ? 'text' : 'password'}
                          value={keyValues[provider] ?? ''}
                          onChange={(event) => changeKeyValue(provider, event.target.value)}
                          spellCheck={false}
                          autoComplete="new-password"
                        />
                        <ToggleButton
                          type="button"
                          onClick={() => toggleKeyVisible(provider)}
                          aria-label={isKeyVisible ? `Hide ${label} key` : `Show ${label} key`}
                          aria-pressed={isKeyVisible}
                        >
                          <FontAwesomeIcon icon={isKeyVisible ? faEyeSlash : faEye} aria-hidden={true} />
                        </ToggleButton>
                      </ValueWrapper>
                    </Field>
                    <PrimaryButton
                      type="submit"
                      disabled={isSaving || isDeleting}
                      aria-label={status.configured ? `Replace ${label} key` : `Register ${label} key`}
                    >
                      {status.configured ? 'Replace' : 'Register'}
                    </PrimaryButton>
                  </KeyForm>
                  {/* The server asks the provider to accept the key before it stores it, which takes a moment */}
                  {isSaving && <Hint role="status">Checking the key with {label}...</Hint>}
                  {rowError && <FormError role="alert">{rowError}</FormError>}
                </Row>
              );
            })}
          </Table>
        </>
      )}

      <DiscardDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(undefined);
        }}
        onConfirm={handleDelete}
        title={`Remove the ${deleteTarget === undefined ? '' : PROVIDER_LABELS[deleteTarget]} key?`}
        description="Newscasts can no longer call this provider with your key. You can register a key again at any time."
        confirmLabel="Remove"
        keepLabel="Cancel"
      />
    </Section>
  );
}
