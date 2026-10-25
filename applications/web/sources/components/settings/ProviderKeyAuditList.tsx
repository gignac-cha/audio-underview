import { useId } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { useProviderKeyAudit } from '../../hooks/use-provider-keys.ts';
import { PROVIDER_LABELS, type ProviderKeyAuditAction } from '../../schemas/provider-keys.ts';

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

const List = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  overflow: hidden;
`;

const Item = styled.li`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.8125rem;

  &:last-child {
    border-bottom: none;
  }

  @media (max-width: 700px) {
    grid-template-columns: minmax(0, 1fr) auto;

    time {
      grid-column: 1 / -1;
    }
  }
`;

const ProviderName = styled.span`
  font-weight: 600;
  color: var(--text-primary);
`;

const Action = styled('span', {
  shouldForwardProp: (property) => property !== 'action',
})<{ action: ProviderKeyAuditAction }>`
  color: ${({ action }) => (action === 'removed' ? 'var(--color-error)' : 'var(--text-secondary)')};
`;

const Timestamp = styled.time`
  font-size: 0.75rem;
  color: var(--text-secondary);
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
`;

const Message = styled.p`
  margin: 0;
  padding: 1.5rem 1rem;
  text-align: center;
  font-size: 0.875rem;
  color: var(--text-muted);
`;

const ACTION_LABELS: Record<ProviderKeyAuditAction, string> = {
  registered: 'Registered',
  replaced: 'Replaced',
  removed: 'Removed',
  used: 'Used',
};

function formatDateTime(dateString: string) {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The recent history of the provider keys, newest first as the server sends it. Registering or
 * removing a key above loads it again.
 */
export function ProviderKeyAuditList() {
  const identifier = useId();
  const { events, isLoading, error, refetch } = useProviderKeyAudit();

  return (
    <Section aria-labelledby={`${identifier}-title`}>
      <SectionTitle id={`${identifier}-title`}>Provider key history</SectionTitle>
      <Description>When each key was registered, replaced, removed or used, newest first.</Description>

      {isLoading ? (
        <Message role="status">Loading provider key history...</Message>
      ) : error ? (
        <>
          <Message role="alert">Failed to load provider key history: {error.message}</Message>
          <div>
            <GhostButton type="button" onClick={() => refetch()} aria-label="Retry loading provider key history">
              <FontAwesomeIcon icon={faArrowsRotate} aria-hidden={true} />
              Retry
            </GhostButton>
          </div>
        </>
      ) : events.length === 0 ? (
        <Message>No provider key history yet.</Message>
      ) : (
        <List>
          {events.map((event, index) => (
            // The same provider, action and time can repeat (two uses in one second), so the position is part of the key
            <Item key={`${index}-${event.provider}-${event.action}-${event.at}`}>
              <ProviderName>{PROVIDER_LABELS[event.provider]}</ProviderName>
              <Action action={event.action}>{ACTION_LABELS[event.action]}</Action>
              <Timestamp dateTime={event.at}>{formatDateTime(event.at)}</Timestamp>
            </Item>
          ))}
        </List>
      )}
    </Section>
  );
}
