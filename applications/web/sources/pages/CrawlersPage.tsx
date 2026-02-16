import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPlus, faArrowLeft, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 4rem 1.5rem;
  animation: ${fadeIn} 0.4s ease-out;
  text-align: center;
`;

const ComingSoon = styled.p`
  font-size: 1.25rem;
  color: var(--text-muted);
  margin: 0 0 2rem 0;
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

export function CrawlersPage() {
  const navigate = useNavigate();
  const { logout } = useAuthentication();

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
        <ComingSoon>Coming Soon</ComingSoon>
        <NewCrawlerButton onClick={() => navigate('/crawlers/new')}>
          <FontAwesomeIcon icon={faPlus} />
          New Crawler
        </NewCrawlerButton>
      </Main>
    </PageContainer>
  );
}
