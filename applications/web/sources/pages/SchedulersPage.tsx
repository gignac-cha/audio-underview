import { useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faSignOutAlt, faTrash, faClock, faArrowsRotate, faCheck, faBan } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useToast } from '../hooks/use-toast.ts';
import { useListSchedulers, useDeleteScheduler } from '../hooks/use-scheduler-manager.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { SchedulerCreateDialog } from '../components/schedulers/SchedulerCreateDialog.tsx';

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const PageContainer = styled.div`
  min-height: 100vh;
  background: var(--bg-deep);
`;

const Main = styled.main`
  padding: 2rem 1.5rem;
  max-width: 800px;
  margin: 0 auto;
  animation: ${fadeIn} 0.4s ease-out;
`;

const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
  text-align: center;
`;

const EmptyIcon = styled.div`
  font-size: 2.5rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
  opacity: 0.5;
`;

const EmptyMessage = styled.p`
  font-size: 1rem;
  color: var(--text-muted);
  margin: 0 0 1.5rem 0;
`;

const LoadingContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
`;

const Spinner = styled.div`
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-subtle);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: ${spin} 0.8s linear infinite;
`;

const SchedulerList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const SchedulerCard = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  transition: var(--transition-fast);
  cursor: pointer;

  &:hover {
    border-color: var(--border-focus);
  }
`;

const SchedulerInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const SchedulerName = styled.h3`
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 0.25rem 0;
`;

const SchedulerMeta = styled.p`
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
  margin: 0 0 0.25rem 0;
  display: flex;
  align-items: center;
  gap: 0.75rem;
`;

const EnabledBadge = styled('span', {
  shouldForwardProp: (prop) => prop !== 'enabled',
})<{ enabled: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.6875rem;
  color: ${({ enabled }) => (enabled ? 'var(--color-success)' : 'var(--text-muted)')};
`;

const SchedulerDate = styled.p`
  font-size: 0.6875rem;
  color: var(--text-muted);
  margin: 0;
`;

const DeleteButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: var(--transition-fast);
  flex-shrink: 0;
  margin-left: 0.75rem;

  &:hover {
    color: var(--color-error);
    background: rgba(239, 68, 68, 0.1);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const NewButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    opacity: 0.9;
  }
`;

const RetryButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--border-focus);
  }
`;

const LoadMoreContainer = styled.div`
  display: flex;
  justify-content: center;
  margin-top: 1.25rem;
`;

const LoadMoreButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--border-focus);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
`;

const TopBar = styled.div`
  display: flex;
  justify-content: flex-end;
  margin-bottom: 1.25rem;
`;

const ConfirmOverlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
  animation: ${fadeIn} 0.15s ease-out;
`;

const ConfirmModal = styled.div`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90vw;
  max-width: 400px;
  box-shadow: var(--shadow-md);
  animation: ${fadeIn} 0.15s ease-out;
`;

const ConfirmTitle = styled.h2`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 0.75rem 0;
`;

const ConfirmMessage = styled.p`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

const ConfirmButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
`;

const ConfirmCancelButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const ConfirmDeleteButton = styled.button`
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: #fff;
  background: var(--color-error);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    opacity: 0.9;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
`;

function formatDate(dateString: string) {
  return new Date(dateString).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function SchedulersPage() {
  const navigate = useNavigate();
  const { logout } = useAuthentication();
  const { showToast } = useToast();
  const { schedulers, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useListSchedulers();
  const { deleteScheduler, status: deleteStatus } = useDeleteScheduler();
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; name: string } | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const handleDelete = (event: React.MouseEvent, id: string, name: string) => {
    event.stopPropagation();
    setConfirmTarget({ id, name });
  };

  const handleConfirmDelete = async () => {
    if (!confirmTarget) return;

    const { id, name } = confirmTarget;
    try {
      await deleteScheduler(id);
      showToast('Deleted', `Scheduler "${name}" has been deleted.`, 'success');
      setConfirmTarget(null);
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Failed to delete scheduler';
      showToast('Error', message, 'error');
      setConfirmTarget(null);
    }
  };

  return (
    <PageContainer>
      <Header>
        <NavigationLinks />
        <LogoutButton onClick={logout}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </LogoutButton>
      </Header>

      <Main>
        {isLoading ? (
          <LoadingContainer>
            <Spinner />
          </LoadingContainer>
        ) : error ? (
          <EmptyState>
            <EmptyMessage>Failed to load schedulers. Please try again.</EmptyMessage>
            <RetryButton onClick={() => refetch()}>
              <FontAwesomeIcon icon={faArrowsRotate} />
              Retry
            </RetryButton>
          </EmptyState>
        ) : schedulers.length === 0 ? (
          <EmptyState>
            <EmptyIcon>
              <FontAwesomeIcon icon={faClock} />
            </EmptyIcon>
            <EmptyMessage>No schedulers yet. Create your first pipeline!</EmptyMessage>
            <NewButton onClick={() => setCreateDialogOpen(true)}>
              <FontAwesomeIcon icon={faPlus} />
              New Scheduler
            </NewButton>
          </EmptyState>
        ) : (
          <>
            <TopBar>
              <NewButton onClick={() => setCreateDialogOpen(true)}>
                <FontAwesomeIcon icon={faPlus} />
                New Scheduler
              </NewButton>
            </TopBar>
            <SchedulerList>
              {schedulers.map((scheduler) => (
                <SchedulerCard key={scheduler.id} onClick={() => navigate(`/schedulers/${scheduler.id}`)}>
                  <SchedulerInfo>
                    <SchedulerName>{scheduler.name}</SchedulerName>
                    <SchedulerMeta>
                      {scheduler.cron_expression ?? 'Manual only'}
                      <EnabledBadge enabled={scheduler.is_enabled}>
                        <FontAwesomeIcon icon={scheduler.is_enabled ? faCheck : faBan} />
                        {scheduler.is_enabled ? 'Enabled' : 'Disabled'}
                      </EnabledBadge>
                    </SchedulerMeta>
                    <SchedulerDate>Created {formatDate(scheduler.created_at)}</SchedulerDate>
                  </SchedulerInfo>
                  <DeleteButton
                    onClick={(event) => handleDelete(event, scheduler.id, scheduler.name)}
                    disabled={deleteStatus === 'pending'}
                    title="Delete scheduler"
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </DeleteButton>
                </SchedulerCard>
              ))}
            </SchedulerList>
            {hasNextPage && (
              <LoadMoreContainer>
                <LoadMoreButton onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? 'Loading...' : 'Load More'}
                </LoadMoreButton>
              </LoadMoreContainer>
            )}
          </>
        )}
      </Main>

      <SchedulerCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      {confirmTarget && (
        <>
          <ConfirmOverlay onClick={() => setConfirmTarget(null)} />
          <ConfirmModal
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setConfirmTarget(null);
            }}
          >
            <ConfirmTitle id="confirm-dialog-title">Delete Scheduler</ConfirmTitle>
            <ConfirmMessage id="confirm-dialog-description">
              Are you sure you want to delete &ldquo;{confirmTarget.name}&rdquo;? This will also delete all stages
              and run history. This action cannot be undone.
            </ConfirmMessage>
            <ConfirmButtonRow>
              <ConfirmCancelButton onClick={() => setConfirmTarget(null)} autoFocus>
                Cancel
              </ConfirmCancelButton>
              <ConfirmDeleteButton onClick={handleConfirmDelete} disabled={deleteStatus === 'pending'}>
                Delete
              </ConfirmDeleteButton>
            </ConfirmButtonRow>
          </ConfirmModal>
        </>
      )}
    </PageContainer>
  );
}
