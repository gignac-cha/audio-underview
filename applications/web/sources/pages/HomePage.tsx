import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import { UserAvatar } from '../components/UserAvatar.tsx';

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
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

const Logo = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);

  svg {
    color: var(--accent-primary);
    font-size: 1.1em;
  }
`;

const UserSection = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
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
  justify-content: center;
  padding: 4rem 1.5rem;
  animation: ${fadeIn} 0.4s ease-out;
`;

const WelcomeCard = styled.div`
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  padding: 2.5rem;
  text-align: center;
  max-width: 480px;
  width: 100%;
  box-shadow: var(--shadow-sm);

  h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  > p {
    font-size: 1rem;
    color: var(--text-secondary);
    margin: 0 0 2rem 0;
  }
`;

const UserInfo = styled.div`
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 1.25rem;
  background: var(--bg-deep);
  border-radius: 12px;
  border: 1px solid var(--border-subtle);
`;

const UserDetails = styled.div`
  text-align: left;
`;

const UserName = styled.p`
  margin: 0 0 0.25rem 0;
  font-weight: 600;
  color: var(--text-primary);
  font-size: 1rem;
`;

const UserEmail = styled.p`
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
`;

export function HomePage() {
  const { user, logout } = useAuthentication();

  return (
    <PageContainer>
      <Header>
        <Logo>
          <FontAwesomeIcon icon={faHeadphones} />
          <span>Audio Underview</span>
        </Logo>

        <UserSection>
          <UserAvatar user={user} />

          <LogoutButton onClick={logout}>
            <FontAwesomeIcon icon={faSignOutAlt} />
            <span>Sign Out</span>
          </LogoutButton>
        </UserSection>
      </Header>

      <Main>
        <WelcomeCard>
          <h1>Welcome, {user?.name}!</h1>
          <p>You are successfully signed in.</p>

          <UserInfo>
            <UserAvatar user={user} size="large" />

            <UserDetails>
              <UserName>{user?.name}</UserName>
              <UserEmail>{user?.email}</UserEmail>
            </UserDetails>
          </UserInfo>
        </WelcomeCard>
      </Main>
    </PageContainer>
  );
}
