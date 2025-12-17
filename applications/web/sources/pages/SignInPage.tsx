import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { GoogleLogin } from '@react-oauth/google';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones } from '@fortawesome/free-solid-svg-icons';
import {
  faApple,
  faMicrosoft,
  faFacebook,
  faGithub,
  faDiscord,
} from '@fortawesome/free-brands-svg-icons';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';
import './SignInPage.scss';

// Provider display configurations
const SOCIAL_PROVIDERS: Array<{
  id: string;
  name: string;
  icon: typeof faApple | null;
  color: string;
  textColor?: string;
}> = [
  { id: 'apple', name: 'Apple', icon: faApple, color: '#000000' },
  { id: 'microsoft', name: 'Microsoft', icon: faMicrosoft, color: '#00A4EF' },
  { id: 'facebook', name: 'Facebook', icon: faFacebook, color: '#1877F2' },
  { id: 'github', name: 'GitHub', icon: faGithub, color: '#333333' },
  { id: 'discord', name: 'Discord', icon: faDiscord, color: '#5865F2' },
  { id: 'kakao', name: 'Kakao', icon: null, color: '#FEE500', textColor: '#000000' },
  { id: 'naver', name: 'Naver', icon: null, color: '#03C75A' },
];

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated, login } = useAuthentication();
  const { showError, showToast } = useToast();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/home', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleGoogleLoginSuccess = (credentialResponse: Parameters<typeof login>[0]) => {
    const result = login(credentialResponse);
    if (!result.success) {
      showError('로그인에 실패했습니다.', result.error ?? '다시 시도해주세요.');
    }
  };

  const handleGoogleLoginError = () => {
    console.error('Google login failed');
    showError('로그인에 실패했습니다.', '다시 시도해주세요.');
  };

  const handleSocialLogin = (providerID: string, providerName: string) => {
    // TODO: Implement OAuth flow for each provider
    showToast(`${providerName} 로그인`, '아직 구현되지 않았습니다.', 'info');
    console.log(`Login with ${providerID} requested`);
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
          {/* Google Login - using @react-oauth/google */}
          <div className="oauth-button-wrapper">
            <GoogleLogin
              onSuccess={handleGoogleLoginSuccess}
              onError={handleGoogleLoginError}
              theme="outline"
              size="large"
              shape="rectangular"
              text="signin_with"
              locale="en"
            />
          </div>

          {/* Other Social Providers */}
          {SOCIAL_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              className="social-login-button"
              style={{
                backgroundColor: provider.color,
                color: provider.textColor ?? '#FFFFFF',
              }}
              onClick={() => handleSocialLogin(provider.id, provider.name)}
            >
              {provider.icon ? (
                <FontAwesomeIcon icon={provider.icon} className="social-icon" />
              ) : (
                <span className="social-icon-text">{provider.name[0]}</span>
              )}
              <span className="social-button-text">Sign in with {provider.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
