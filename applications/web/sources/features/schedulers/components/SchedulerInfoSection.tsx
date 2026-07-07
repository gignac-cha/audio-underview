import { isValidCronExpression, type Scheduler } from '@audio-underview/schemas';
import { toErrorMessage } from '../../../api/errors.ts';
import {
  useExecuteScheduler,
  useUpdateScheduler,
  type UpdateSchedulerBody,
} from '../../../api/schedulers.ts';
import { Button } from '../../../components/Button.tsx';
import { Icon } from '../../../components/Icon.tsx';
import { Section } from '../../../components/Section.tsx';
import { Toggle } from '../../../components/Toggle.tsx';
import { formatDateTime } from '../../../tools/format.ts';
import { useToasts } from '../../../state/toasts.ts';
import { InlineEditText } from './InlineEditText.tsx';
import styles from './SchedulerInfoSection.module.css';

/** 인라인 편집 + 수동 실행 트리거(개선 §9). */
export const SchedulerInfoSection = ({ scheduler }: { scheduler: Scheduler }) => {
  const { updateScheduler } = useUpdateScheduler(scheduler.id);
  const { executeScheduler, status: executeStatus } = useExecuteScheduler(scheduler.id);
  const { showSuccess, showError } = useToasts();

  const commitUpdate = async (body: UpdateSchedulerBody) => {
    try {
      await updateScheduler(body);
    } catch (error) {
      showError('Update failed', toErrorMessage(error));
    }
  };

  const runNow = async () => {
    try {
      const result = await executeScheduler();
      showSuccess('Run finished', `Final status: ${result.status}.`);
    } catch (error) {
      showError('Run failed', toErrorMessage(error));
    }
  };

  return (
    <Section
      title="Scheduler"
      actions={
        <Button
          variant="primary"
          size="small"
          iconLeft={<Icon name="bolt" size={14} />}
          disabled={executeStatus === 'pending'}
          onClick={() => void runNow()}
        >
          {executeStatus === 'pending' ? 'Running…' : 'Run now'}
        </Button>
      }
    >
      <dl className={styles.grid}>
        <div className={styles.row}>
          <dt className={styles.label}>Name</dt>
          <dd className={styles.value}>
            <InlineEditText
              value={scheduler.name}
              ariaLabel="Scheduler name"
              onCommit={(next) => {
                if (next !== null) {
                  void commitUpdate({ name: next });
                }
              }}
            />
          </dd>
        </div>

        <div className={styles.row}>
          <dt className={styles.label}>Cron</dt>
          <dd className={styles.value}>
            <InlineEditText
              value={scheduler.cron_expression ?? ''}
              ariaLabel="Cron expression"
              placeholder="0 9 * * 1-5"
              monospace
              allowEmpty
              emptyDisplay="Manual only"
              invalid={(candidate) => !isValidCronExpression(candidate)}
              onCommit={(next) => {
                void commitUpdate({ cron_expression: next });
              }}
            />
          </dd>
        </div>

        <div className={styles.row}>
          <dt className={styles.label}>Enabled</dt>
          <dd className={styles.value}>
            <Toggle
              checked={scheduler.is_enabled}
              label="Scheduler enabled"
              onChange={(next) => {
                void commitUpdate({ is_enabled: next });
              }}
            />
          </dd>
        </div>

        <div className={styles.row}>
          <dt className={styles.label}>Last run</dt>
          <dd className={styles.value}>
            {scheduler.last_run_at === null ? 'Never' : formatDateTime(scheduler.last_run_at)}
          </dd>
        </div>

        <div className={styles.row}>
          <dt className={styles.label}>Created</dt>
          <dd className={styles.value}>{formatDateTime(scheduler.created_at)}</dd>
        </div>
      </dl>
    </Section>
  );
};
