import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faHeadphones } from '@fortawesome/free-solid-svg-icons';
import {
  faApple,
  faMicrosoft,
  faFacebook,
  faGithub,
  faDiscord,
  faGoogle,
} from '@fortawesome/free-brands-svg-icons';
import {
  useAuthentication,
  type OAuthProviderID,
  type ProviderDisplayConfiguration,
} from '../contexts/AuthenticationContext.tsx';
import { SignInButtons } from '../components/SignInButtons.tsx';
import { useToast } from '../contexts/ToastContext.tsx';

const PROVIDER_ICONS: Partial<Record<OAuthProviderID, IconDefinition>> = {
  google: faGoogle,
  apple: faApple,
  microsoft: faMicrosoft,
  facebook: faFacebook,
  github: faGithub,
  discord: faDiscord,
};

const fadeUp = keyframes`
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const PageContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  padding: 1rem;
  position: relative;
  background: radial-gradient(
    circle at 50% 100%,
    var(--bg-accent-dark) 0%,
    var(--bg-deep) 50%
  );
`;

const Container = styled.div`
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  padding: 2.5rem 1.5rem;
  width: 100%;
  max-width: 420px;
  text-align: center;
  box-shadow: var(--shadow-md);
  animation: ${fadeUp} 0.4s ease-out;
`;

const Header = styled.div`
  margin-bottom: 1.5rem;

  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  p {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin: 0;
  }
`;

const SignInIcon = styled.span`
  font-size: 2.5rem;
  color: var(--accent-primary);
  margin-bottom: 1rem;
  display: inline-block;
`;

const ButtonContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  align-items: stretch;
`;

const SocialIcon = styled.span`
  font-size: 1.25rem;
  width: 1.25rem;

  svg {
    font-size: 1.25rem;
    width: 1.25rem;
  }
`;

const SocialIconText = styled.span`
  font-size: 1rem;
  font-weight: 700;
  width: 1.25rem;
  text-align: center;
`;

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthentication();
  const { showError, showToast } = useToast();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/home', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleError = (error: string, providerID: OAuthProviderID) => {
    console.error(`${providerID} login failed:`, error);
    showError('로그인에 실패했습니다.', error ?? '다시 시도해주세요.');
  };

  const handleProviderClick = (providerID: OAuthProviderID) => {
    showToast(`${providerID} 로그인`, '아직 구현되지 않았습니다.', 'info');
    console.log(`Login with ${providerID} requested`);
  };

  const renderIcon = (providerID: OAuthProviderID, config: ProviderDisplayConfiguration) => {
    const icon = PROVIDER_ICONS[providerID];

    if (icon) {
      return (
        <SocialIcon>
          <FontAwesomeIcon icon={icon} />
        </SocialIcon>
      );
    }

    if (config.iconType === 'svg') {
      return (
        <SocialIcon>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox={config.svgViewBox}
            fill="currentColor"
            width="1.25em"
            height="1.25em"
            role="img"
            aria-label={`${config.displayName} logo`}
          >
            <path d={config.svgPath} />
          </svg>
        </SocialIcon>
      );
    }

    if (config.iconType === 'text') {
      return <SocialIconText>{config.iconText}</SocialIconText>;
    }

    return <SocialIconText>{config.displayName[0]}</SocialIconText>;
  };

  return (
    <PageContainer>
      <Container>
        <Header>
          <SignInIcon>
            <FontAwesomeIcon icon={faHeadphones} />
          </SignInIcon>
          <h1>Audio Underview</h1>
          <p>Sign in to continue</p>
        </Header>

        <ButtonContainer>
          <SignInButtons
            onError={handleError}
            onProviderClick={handleProviderClick}
            renderIcon={renderIcon}
          />
        </ButtonContainer>
      </Container>
    </PageContainer>
  );
}
