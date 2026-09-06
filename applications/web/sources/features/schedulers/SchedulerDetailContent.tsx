import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useListCrawlers } from '../../api/crawlers.ts';
import { useGetScheduler, useListStages } from '../../api/schedulers.ts';
import { Button } from '../../components/Button.tsx';
import { Icon } from '../../components/Icon.tsx';
import { Spinner } from '../../components/Spinner.tsx';
import { RunHistorySection } from './components/RunHistorySection.tsx';
import { SchedulerInfoSection } from './components/SchedulerInfoSection.tsx';
import { StageCreateDialog } from './components/StageCreateDialog.tsx';
import { StageList } from './components/StageList.tsx';
import styles from './SchedulerDetailContent.module.css';

export const SchedulerDetailContent = ({ id }: { id: string }) => {
  const navigate = useNavigate();
  const { scheduler, isLoading, error, refetch } = useGetScheduler(id);
  const { stages, isLoading: stagesLoading } = useListStages(id);
  const crawlerList = useListCrawlers();
  const [createOpen, setCreateOpen] = useState(false);

  const crawlerMap = useMemo(
    () => new Map(crawlerList.crawlers.map((crawler) => [crawler.id, crawler.name])),
    [crawlerList.crawlers],
  );

  return (
    <div className={styles.content}>
      <div className={styles.topBar}>
        <Button
          variant="ghost"
          size="small"
          iconLeft={<Icon name="arrowLeft" size={16} />}
          onClick={() => {
            void navigate('/schedulers');
          }}
        >
          Back to schedulers
        </Button>
      </div>

      {isLoading && scheduler === undefined && (
        <div className={styles.centered}>
          <Spinner size={24} label="Loading scheduler…" />
        </div>
      )}

      {error !== undefined && scheduler === undefined && (
        <div className={styles.state} role="alert">
          <p className={styles.stateTitle}>Failed to load scheduler.</p>
          <p className={styles.stateDescription}>{error.message}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {scheduler !== undefined && (
        <div className={styles.grid}>
          <SchedulerInfoSection scheduler={scheduler} />

          {stagesLoading ? (
            <div className={styles.centered}>
              <Spinner size={20} label="Loading pipeline…" />
            </div>
          ) : (
            <StageList
              schedulerID={id}
              stages={stages}
              crawlerMap={crawlerMap}
              onAddStage={() => {
                setCreateOpen(true);
              }}
            />
          )}

          <RunHistorySection schedulerID={id} />
        </div>
      )}

      <StageCreateDialog
        open={createOpen}
        schedulerID={id}
        nextOrder={stages.length}
        onClose={() => {
          setCreateOpen(false);
        }}
      />
    </div>
  );
};
