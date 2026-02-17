import { useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faArrowLeft, faSignOutAlt, faTrash, faSpider, faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useToast } from '../hooks/use-toast.ts';
import { useListCrawlers, useDeleteCrawler } from '../hooks/use-crawler-manager.ts';

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

const Header = styled.header`
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.5rem;
  background: rgba(10, 10, 10, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-subtle);
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const BackButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
`;

const PageTitle = styled.h1`
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
`;

const LogoutButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  span {
    display: none;

    @media (min-width: 640px) {
      display: inline;
    }
  }
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

const CrawlerList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const CrawlerCard = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  transition: var(--transition-fast);

  &:hover {
    border-color: var(--border-focus);
  }
`;

const CrawlerInfo = styled.div`
  flex: 1;
  min-width: 0;
`;

const CrawlerName = styled.h3`
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 0.25rem 0;
`;

const CrawlerPattern = styled.p`
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
  margin: 0 0 0.25rem 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CrawlerDate = styled.p`
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

const NewCrawlerButton = styled.button`
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

export function CrawlersPage() {
  const navigate = useNavigate();
  const { logout } = useAuthentication();
  const { showToast } = useToast();
  const { crawlers, isLoading, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useListCrawlers();
  const { deleteCrawler, status: deleteStatus } = useDeleteCrawler();
  const [deletingID, setDeletingID] = useState<string | null>(null);

  const handleDelete = async (id: string, name: string) => {
    const confirmed = window.confirm(`Delete crawler "${name}"?`);
    if (!confirmed) return;

    setDeletingID(id);
    try {
      await deleteCrawler(id);
      showToast('Deleted', `Crawler "${name}" has been deleted.`, 'success');
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Failed to delete crawler';
      showToast('Error', message, 'error');
    } finally {
      setDeletingID(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <PageContainer>
      <Header>
        <HeaderLeft>
          <BackButton onClick={() => navigate('/home')}>
            <FontAwesomeIcon icon={faArrowLeft} />
            Home
          </BackButton>
          <PageTitle>Crawlers</PageTitle>
        </HeaderLeft>

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
            <EmptyMessage>Failed to load crawlers. Please try again.</EmptyMessage>
            <RetryButton onClick={() => refetch()}>
              <FontAwesomeIcon icon={faArrowsRotate} />
              Retry
            </RetryButton>
          </EmptyState>
        ) : crawlers.length === 0 ? (
          <EmptyState>
            <EmptyIcon>
              <FontAwesomeIcon icon={faSpider} />
            </EmptyIcon>
            <EmptyMessage>No crawlers yet. Create your first one!</EmptyMessage>
            <NewCrawlerButton onClick={() => navigate('/crawlers/new')}>
              <FontAwesomeIcon icon={faPlus} />
              New Crawler
            </NewCrawlerButton>
          </EmptyState>
        ) : (
          <>
            <TopBar>
              <NewCrawlerButton onClick={() => navigate('/crawlers/new')}>
                <FontAwesomeIcon icon={faPlus} />
                New Crawler
              </NewCrawlerButton>
            </TopBar>
            <CrawlerList>
              {crawlers.map((crawler) => (
                <CrawlerCard key={crawler.id}>
                  <CrawlerInfo>
                    <CrawlerName>{crawler.name}</CrawlerName>
                    <CrawlerPattern>{crawler.url_pattern}</CrawlerPattern>
                    <CrawlerDate>Created {formatDate(crawler.created_at)}</CrawlerDate>
                  </CrawlerInfo>
                  <DeleteButton
                    onClick={() => handleDelete(crawler.id, crawler.name)}
                    disabled={deleteStatus === 'pending'}
                    title="Delete crawler"
                  >
                    <FontAwesomeIcon icon={faTrash} />
                  </DeleteButton>
                </CrawlerCard>
              ))}
            </CrawlerList>
            {hasNextPage && (
              <LoadMoreContainer>
                <LoadMoreButton
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load More'}
                </LoadMoreButton>
              </LoadMoreContainer>
            )}
          </>
        )}
      </Main>
    </PageContainer>
  );
}
