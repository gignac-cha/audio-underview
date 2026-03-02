import { useMemo } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt, faArrowLeft, faArrowsRotate } from '@fortawesome/free-solid-svg-icons';
import { useParams, useNavigate } from 'react-router';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useGetScheduler, useListStages } from '../hooks/use-scheduler-manager.ts';
import { useListCrawlers } from '../hooks/use-crawler-manager.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { SchedulerInfoSection } from '../components/schedulers/SchedulerInfoSection.tsx';
import { StageList } from '../components/schedulers/StageList.tsx';
import { RunHistorySection } from '../components/schedulers/RunHistorySection.tsx';

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

const BackButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);
  margin-bottom: 1.25rem;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }
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

const ErrorState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
  text-align: center;
`;

const ErrorMessage = styled.p`
  font-size: 1rem;
  color: var(--text-muted);
  margin: 0 0 1.5rem 0;
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

export function SchedulerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { logout } = useAuthentication();
  const { scheduler, isLoading, error, refetch } = useGetScheduler(id);
  const { stages, isLoading: stagesLoading, error: stagesError, refetch: refetchStages } = useListStages(id);
  const { crawlers, isLoading: crawlersLoading, error: crawlersError, refetch: refetchCrawlers } = useListCrawlers();

  const crawlerMap = useMemo(() => {
    const map = new Map<string, (typeof crawlers)[number]>();
    for (const crawler of crawlers) {
      map.set(crawler.id, crawler);
    }
    return map;
  }, [crawlers]);

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
        <BackButton onClick={() => navigate('/schedulers')}>
          <FontAwesomeIcon icon={faArrowLeft} />
          Back to Schedulers
        </BackButton>

        {isLoading ? (
          <LoadingContainer>
            <Spinner />
          </LoadingContainer>
        ) : error ? (
          <ErrorState>
            <ErrorMessage>Failed to load scheduler.</ErrorMessage>
            <RetryButton onClick={() => refetch()}>
              <FontAwesomeIcon icon={faArrowsRotate} />
              Retry
            </RetryButton>
          </ErrorState>
        ) : scheduler ? (
          <>
            <SchedulerInfoSection scheduler={scheduler} />
            {stagesLoading || crawlersLoading ? (
              <LoadingContainer>
                <Spinner />
              </LoadingContainer>
            ) : stagesError || crawlersError ? (
              <ErrorState>
                <ErrorMessage>
                  {stagesError && crawlersError
                    ? 'Failed to load stages and crawlers.'
                    : stagesError
                      ? 'Failed to load stages.'
                      : 'Failed to load crawlers.'}
                </ErrorMessage>
                <RetryButton onClick={() => {
                  if (stagesError) refetchStages();
                  if (crawlersError) refetchCrawlers();
                }}>
                  <FontAwesomeIcon icon={faArrowsRotate} />
                  Retry
                </RetryButton>
              </ErrorState>
            ) : (
              <StageList schedulerID={scheduler.id} stages={stages} crawlerMap={crawlerMap} />
            )}
            <RunHistorySection schedulerID={scheduler.id} />
          </>
        ) : null}
      </Main>
    </PageContainer>
  );
}
