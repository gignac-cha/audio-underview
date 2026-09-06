import { isValidCronExpression } from '@audio-underview/schemas';
import { useState } from 'react';
import { useCreateScheduler } from '../../../api/schedulers.ts';
import { toErrorMessage } from '../../../api/errors.ts';
import { Button } from '../../../components/Button.tsx';
import { TextField } from '../../../components/FormControls.tsx';
import { Modal } from '../../../components/Modal.tsx';
import { Toggle } from '../../../components/Toggle.tsx';
import { useToasts } from '../../../state/toasts.ts';
import styles from './SchedulerCreateDialog.module.css';

export interface SchedulerCreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export const SchedulerCreateDialog = ({ open, onClose, onCreated }: SchedulerCreateDialogProps) => {
  const { createScheduler, status } = useCreateScheduler();
  const { showSuccess, showError } = useToasts();
  const [name, setName] = useState('');
  const [cron, setCron] = useState('');
  const [enabled, setEnabled] = useState(true);

  const busy = status === 'pending';
  const trimmedCron = cron.trim();
  const cronInvalid = trimmedCron.length > 0 && !isValidCronExpression(trimmedCron);
  const canSubmit = name.trim().length > 0 && !cronInvalid;

  const reset = () => {
    setName('');
    setCron('');
    setEnabled(true);
  };

  const handleClose = () => {
    if (!busy) {
      reset();
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }
    try {
      const created = await createScheduler({
        name: name.trim(),
        cron_expression: trimmedCron.length > 0 ? trimmedCron : null,
        is_enabled: enabled,
      });
      showSuccess(`Scheduler "${created.name}" has been created.`);
      reset();
      onCreated(created.id);
    } catch (error) {
      showError('Create failed', toErrorMessage(error));
    }
  };

  return (
    <Modal
      open={open}
      title="New Scheduler"
      busy={busy}
      onClose={handleClose}
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={!canSubmit || busy}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        value={name}
        placeholder="Daily news digest"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label="Cron expression"
        value={cron}
        placeholder="0 9 * * 1-5"
        className={styles.mono}
        error={cronInvalid ? 'Invalid cron expression (expects 5 fields).' : undefined}
        helper="Leave empty for manual-only runs."
        onChange={(event) => {
          setCron(event.target.value);
        }}
      />
      <div className={styles.toggleRow}>
        <div>
          <p className={styles.toggleLabel}>Enabled</p>
          <p className={styles.toggleHint}>Scheduled runs fire only while enabled.</p>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
      </div>
    </Modal>
  );
};
