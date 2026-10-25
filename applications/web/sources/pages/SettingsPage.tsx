import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { EnvironmentVariablesSection } from '../components/settings/EnvironmentVariablesSection.tsx';
import { ProviderKeysSection } from '../components/settings/ProviderKeysSection.tsx';
import { ProviderKeyAuditList } from '../components/settings/ProviderKeyAuditList.tsx';

const fadeIn = keyframes`
  from { opacity: 0; }
  to { opacity: 1; }
`;

const PageContainer = styled.div`
  min-height: 100vh;
  background: var(--bg-deep);
`;

const Main = styled.main`
  padding: 2rem 1.5rem;
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 2rem;
  animation: ${fadeIn} 0.4s ease-out;
`;

const PageTitle = styled.h1`
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

export function SettingsPage() {
  const { logout } = useAuthentication();

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
        <PageTitle>Settings</PageTitle>
        <EnvironmentVariablesSection />
        <ProviderKeysSection />
        <ProviderKeyAuditList />
      </Main>
    </PageContainer>
  );
}
