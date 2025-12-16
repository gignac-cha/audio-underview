import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { GoogleLogin } from '@react-oauth/google';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones } from '@fortawesome/free-solid-svg-icons';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import './SignInPage.scss';

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated, login } = useAuthentication();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/home', { replace: true });
    }
  }, [isAuthenticated, navigate]);

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
            onSuccess={login}
            onError={() => {
              console.error('Login failed');
            }}
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
