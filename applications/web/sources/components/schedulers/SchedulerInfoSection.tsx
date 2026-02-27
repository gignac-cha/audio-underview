import { useState, useRef } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPen } from '@fortawesome/free-solid-svg-icons';
import type { SchedulerRow } from '@audio-underview/supabase-connector';
import { useUpdateScheduler } from '../../hooks/use-scheduler-manager.ts';
import { useToast } from '../../hooks/use-toast.ts';

const Container = styled.section`
  margin-bottom: 2rem;
  padding: 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const NameRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const Name = styled.h1`
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
  cursor: pointer;

  &:hover {
    color: var(--accent-primary);
  }
`;

const NameInput = styled.input`
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-focus);
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  outline: none;
  width: 100%;
`;

const EditIcon = styled.span`
  color: var(--text-muted);
  font-size: 0.75rem;
`;

const MetaGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
`;

const MetaItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
`;

const MetaLabel = styled.span`
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const MetaValue = styled.span`
  font-size: 0.875rem;
  color: var(--text-secondary);
`;

const EditableValue = styled.span`
  font-size: 0.875rem;
  color: var(--text-secondary);
  cursor: pointer;

  &:hover {
    color: var(--accent-primary);
  }
`;

const CronInput = styled.input`
  font-size: 0.875rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-focus);
  border-radius: 6px;
  padding: 0.25rem 0.5rem;
  font-family: var(--font-mono);
  outline: none;
  width: 100%;
`;

const ToggleSwitch = styled('button', {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active: boolean }>`
  position: relative;
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: ${({ active }) => (active ? 'var(--color-success)' : 'var(--border-subtle)')};
  cursor: pointer;
  transition: background 0.2s;
  border: none;
  padding: 0;

  &::after {
    content: '';
    position: absolute;
    top: 2px;
    left: ${({ active }) => (active ? '18px' : '2px')};
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: white;
    transition: left 0.2s;
  }
`;

const EnabledRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

function formatDateTime(dateString: string | null) {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface SchedulerInfoSectionProperties {
  scheduler: SchedulerRow;
}

export function SchedulerInfoSection({ scheduler }: SchedulerInfoSectionProperties) {
  const { showToast } = useToast();
  const { updateScheduler } = useUpdateScheduler();

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(scheduler.name);
  const [editingCron, setEditingCron] = useState(false);
  const [cronValue, setCronValue] = useState(scheduler.cron_expression ?? '');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const cronInputRef = useRef<HTMLInputElement>(null);

  const saveField = async (field: string, value: unknown) => {
    try {
      await updateScheduler({ id: scheduler.id, [field]: value });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update';
      showToast('Error', message, 'error');
    }
  };

  const handleNameBlur = () => {
    setEditingName(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== scheduler.name) {
      saveField('name', trimmed);
    } else {
      setNameValue(scheduler.name);
    }
  };

  const handleCronBlur = () => {
    setEditingCron(false);
    const trimmed = cronValue.trim();
    const newValue = trimmed || null;
    if (newValue !== scheduler.cron_expression) {
      saveField('cron_expression', newValue);
    }
  };

  const handleToggleEnabled = () => {
    saveField('is_enabled', !scheduler.is_enabled);
  };

  return (
    <Container>
      <NameRow>
        {editingName ? (
          <NameInput
            ref={nameInputRef}
            value={nameValue}
            onChange={(event) => setNameValue(event.target.value)}
            onBlur={handleNameBlur}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleNameBlur();
              if (event.key === 'Escape') {
                setNameValue(scheduler.name);
                setEditingName(false);
              }
            }}
            autoFocus
          />
        ) : (
          <>
            <Name
              onClick={() => {
                setEditingName(true);
                setNameValue(scheduler.name);
              }}
            >
              {scheduler.name}
            </Name>
            <EditIcon>
              <FontAwesomeIcon icon={faPen} />
            </EditIcon>
          </>
        )}
      </NameRow>

      <MetaGrid>
        <MetaItem>
          <MetaLabel>Cron</MetaLabel>
          {editingCron ? (
            <CronInput
              ref={cronInputRef}
              value={cronValue}
              onChange={(event) => setCronValue(event.target.value)}
              onBlur={handleCronBlur}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleCronBlur();
                if (event.key === 'Escape') {
                  setCronValue(scheduler.cron_expression ?? '');
                  setEditingCron(false);
                }
              }}
              placeholder="0 9 * * *"
              autoFocus
            />
          ) : (
            <EditableValue
              onClick={() => {
                setEditingCron(true);
                setCronValue(scheduler.cron_expression ?? '');
              }}
            >
              {scheduler.cron_expression ?? 'Manual only'}
            </EditableValue>
          )}
        </MetaItem>

        <MetaItem>
          <MetaLabel>Enabled</MetaLabel>
          <EnabledRow>
            <ToggleSwitch active={scheduler.is_enabled} onClick={handleToggleEnabled} />
            <MetaValue>{scheduler.is_enabled ? 'Yes' : 'No'}</MetaValue>
          </EnabledRow>
        </MetaItem>

        <MetaItem>
          <MetaLabel>Last Run</MetaLabel>
          <MetaValue>{formatDateTime(scheduler.last_run_at)}</MetaValue>
        </MetaItem>

        <MetaItem>
          <MetaLabel>Created</MetaLabel>
          <MetaValue>{formatDateTime(scheduler.created_at)}</MetaValue>
        </MetaItem>
      </MetaGrid>
    </Container>
  );
}
