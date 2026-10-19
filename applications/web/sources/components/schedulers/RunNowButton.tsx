import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlay } from '@fortawesome/free-solid-svg-icons';
import { useExecuteScheduler } from '../../hooks/use-scheduler-runs.ts';
import { useToast } from '../../hooks/use-toast.ts';

const Button = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    background: var(--accent-muted);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

interface RunNowButtonProperties {
  schedulerID: string;
  // A scheduler without stages has nothing to run
  disabled: boolean;
  // Called with the run once it is recorded, whether it ended well or not
  onRunRecorded: (runID: string) => void;
}

export function RunNowButton({ schedulerID, disabled, onRunRecorded }: RunNowButtonProperties) {
  const { showToast } = useToast();
  const { executeScheduler, status } = useExecuteScheduler();
  const isRunning = status === 'pending';

  const handleClick = async () => {
    try {
      const execution = await executeScheduler(schedulerID);
      onRunRecorded(execution.run_id);
      if (execution.status === 'failed') {
        showToast('Error', execution.error ?? 'Run failed', 'error');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run scheduler';
      showToast('Error', message, 'error');
    }
  };

  return (
    <Button type="button" onClick={handleClick} disabled={disabled || isRunning}>
      <FontAwesomeIcon icon={faPlay} />
      {isRunning ? 'Running...' : 'Run now'}
    </Button>
  );
}
