import type { Scheduler } from '@audio-underview/schemas';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toErrorMessage } from '../api/errors.ts';
import { useDeleteScheduler, useListSchedulers } from '../api/schedulers.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ListPage } from '../components/ListPage.tsx';
import { PageShell } from '../components/PageShell.tsx';
import { SchedulerCard } from '../features/schedulers/components/SchedulerCard.tsx';
import { SchedulerCreateDialog } from '../features/schedulers/components/SchedulerCreateDialog.tsx';
import { useToasts } from '../state/toasts.ts';

export const SchedulersPage = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToasts();
  const list = useListSchedulers();
  const { deleteScheduler, status: deleteStatus } = useDeleteScheduler();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Scheduler | null>(null);

  const confirmDelete = async () => {
    if (pendingDelete === null) {
      return;
    }
    const target = pendingDelete;
    try {
      await deleteScheduler(target.id);
      showSuccess(`Scheduler "${target.name}" has been deleted.`);
    } catch (error) {
      showError('Delete failed', toErrorMessage(error));
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <PageShell>
      <ListPage<Scheduler>
        title="Schedulers"
        icon="scheduler"
        createLabel="New Scheduler"
        onCreate={() => {
          setCreateOpen(true);
        }}
        items={list.schedulers}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
        errorMessage="Failed to load schedulers."
        emptyTitle="No schedulers yet."
        emptyDescription="Create a scheduler to chain crawlers into an automated pipeline."
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => {
          void list.fetchNextPage();
        }}
        getItemKey={(scheduler) => scheduler.id}
        renderItem={(scheduler) => (
          <SchedulerCard
            scheduler={scheduler}
            onOpen={() => {
              void navigate(`/schedulers/${scheduler.id}`);
            }}
            onDelete={() => {
              setPendingDelete(scheduler);
            }}
          />
        )}
      />

      <SchedulerCreateDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={(id) => {
          setCreateOpen(false);
          void navigate(`/schedulers/${id}`);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete scheduler?"
        description={
          pendingDelete === null
            ? null
            : `"${pendingDelete.name}" and all of its stages and run history will be permanently deleted. This action cannot be undone.`
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmVariant="danger"
        initialFocus="cancel"
        busy={deleteStatus === 'pending'}
        onConfirm={() => {
          void confirmDelete();
        }}
        onCancel={() => {
          setPendingDelete(null);
        }}
      />
    </PageShell>
  );
};
