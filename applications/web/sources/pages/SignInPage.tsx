import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { GoogleLogin } from '@react-oauth/google';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones } from '@fortawesome/free-solid-svg-icons';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import { useToast } from '../contexts/ToastContext.tsx';
import './SignInPage.scss';

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated, login } = useAuthentication();
  const { showError } = useToast();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/home', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const handleLoginSuccess = (credentialResponse: Parameters<typeof login>[0]) => {
    const result = login(credentialResponse);
    if (!result.success) {
      showError('로그인에 실패했습니다.', result.error ?? '다시 시도해주세요.');
    }
  };

  const handleLoginError = () => {
    console.error('Google login failed');
    showError('로그인에 실패했습니다.', '다시 시도해주세요.');
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
          <GoogleLogin
            onSuccess={handleLoginSuccess}
            onError={handleLoginError}
            theme="outline"
            size="large"
            shape="rectangular"
            text="signin_with"
            locale="en"
          />
        </div>
      </div>
    </div>
  );
}
