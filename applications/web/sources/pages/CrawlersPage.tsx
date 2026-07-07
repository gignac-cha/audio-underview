import type { Crawler } from '@audio-underview/schemas';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useDeleteCrawler, useListCrawlers } from '../api/crawlers.ts';
import { toErrorMessage } from '../api/errors.ts';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ListPage } from '../components/ListPage.tsx';
import { PageShell } from '../components/PageShell.tsx';
import { CrawlerCard } from '../features/crawlers/components/CrawlerCard.tsx';
import { useToasts } from '../state/toasts.ts';

export const CrawlersPage = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToasts();
  const list = useListCrawlers();
  const { deleteCrawler, status: deleteStatus } = useDeleteCrawler();
  const [pendingDelete, setPendingDelete] = useState<Crawler | null>(null);

  const confirmDelete = async () => {
    if (pendingDelete === null) {
      return;
    }
    const target = pendingDelete;
    try {
      await deleteCrawler(target.id);
      showSuccess(`Crawler "${target.name}" has been deleted.`);
    } catch (error) {
      showError('Delete failed', toErrorMessage(error));
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <PageShell>
      <ListPage<Crawler>
        title="Crawlers"
        icon="crawler"
        createLabel="New Crawler"
        onCreate={() => {
          void navigate('/crawlers/new');
        }}
        items={list.crawlers}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={() => {
          void list.refetch();
        }}
        errorMessage="Failed to load crawlers."
        emptyTitle="No crawlers yet."
        emptyDescription="Create your first crawler to start extracting data from the web."
        hasNextPage={list.hasNextPage}
        isFetchingNextPage={list.isFetchingNextPage}
        onLoadMore={() => {
          void list.fetchNextPage();
        }}
        getItemKey={(crawler) => crawler.id}
        renderItem={(crawler) => (
          <CrawlerCard
            crawler={crawler}
            onOpen={() => {
              void navigate(`/crawlers/${crawler.id}`);
            }}
            onDelete={() => {
              setPendingDelete(crawler);
            }}
          />
        )}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete crawler?"
        description={
          pendingDelete === null
            ? null
            : `"${pendingDelete.name}" will be permanently deleted. This action cannot be undone.`
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
