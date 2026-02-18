import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { UserAvatar } from '../components/UserAvatar.tsx';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton, UserSection } from '../components/PageHeader.tsx';

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
        <NavigationLinks />

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
