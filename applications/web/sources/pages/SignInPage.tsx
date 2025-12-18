import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones } from '@fortawesome/free-solid-svg-icons';
import {
  faApple,
  faMicrosoft,
  faFacebook,
  faGithub,
  faDiscord,
} from '@fortawesome/free-brands-svg-icons';
import {
  useSign,
  SignInButtons,
  type OAuthProviderID,
  type ProviderDisplayConfiguration,
} from '@audio-underview/sign-provider';
import { useToast } from '../contexts/ToastContext.tsx';
import './SignInPage.scss';

// Icon mapping for providers
const PROVIDER_ICONS: Partial<Record<OAuthProviderID, typeof faApple>> = {
  apple: faApple,
  microsoft: faMicrosoft,
  facebook: faFacebook,
  github: faGithub,
  discord: faDiscord,
};

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated } = useSign();
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
    // TODO: Implement OAuth flow for non-Google providers
    showToast(`${providerID} 로그인`, '아직 구현되지 않았습니다.', 'info');
    console.log(`Login with ${providerID} requested`);
  };

  const renderIcon = (providerID: OAuthProviderID, config: ProviderDisplayConfiguration) => {
    const icon = PROVIDER_ICONS[providerID];

    if (icon) {
      return <FontAwesomeIcon icon={icon} className="social-icon" />;
    }

    if (config.iconType === 'text' && config.iconText) {
      return <span className="social-icon-text">{config.iconText}</span>;
    }

    return <span className="social-icon-text">{config.displayName[0]}</span>;
  };

  return (
    <div className="sign-in-page">
      <div className="sign-in-container">
        <div className="sign-in-header">
          <FontAwesomeIcon icon={faHeadphones} className="sign-in-icon" />
          <h1>Audio Underview</h1>
          <p>Sign in to continue</p>
        </div>

        <div className="sign-in-button-container">
          <SignInButtons
            onError={handleError}
            onProviderClick={handleProviderClick}
            buttonClassName="social-login-button"
            renderIcon={renderIcon}
          />
        </div>
      </div>
    </div>
  );
}
