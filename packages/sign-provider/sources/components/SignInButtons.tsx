import type { ReactNode, CSSProperties } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { useSign } from '../contexts/SignContext.tsx';
import type { OAuthProviderID } from '../types/index.ts';
import {
  PROVIDER_DISPLAY_CONFIGURATIONS,
  type ProviderDisplayConfiguration,
} from '../providers/configurations.ts';

export interface SignInButtonsProps {
  /** Callback when login fails */
  onError?: (error: string, providerID: OAuthProviderID) => void;
  /** Callback when a non-Google provider is clicked (for custom handling) */
  onProviderClick?: (providerID: OAuthProviderID) => void;
  /** Custom class name for the container */
  className?: string;
  /** Custom class name for each button */
  buttonClassName?: string;
  /** Custom styles for the container */
  style?: CSSProperties;
  /** Render custom icon for a provider */
  renderIcon?: (providerID: OAuthProviderID, config: ProviderDisplayConfiguration) => ReactNode;
}

function GoogleSignInButton({
  onError,
  buttonClassName,
  renderIcon,
}: {
  onError?: (error: string) => void;
  buttonClassName?: string;
  renderIcon?: (providerID: OAuthProviderID, config: ProviderDisplayConfiguration) => ReactNode;
}) {
  const { loginWithGoogle } = useSign();
  const config = PROVIDER_DISPLAY_CONFIGURATIONS['google'];

  const googleLogin = useGoogleLogin({
    onSuccess: (tokenResponse) => {
      // useGoogleLogin with implicit flow returns access_token, not id_token
      // We need to use the credential response from Google One Tap or redirect flow
      // For now, we'll fetch user info using the access token
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      })
        .then((response) => response.json())
        .then((userInfo) => {
          const result = loginWithGoogle({
            credential: tokenResponse.access_token,
            clientId: '',
            select_by: 'btn',
          }, userInfo);
          if (!result.success) {
            onError?.(result.error ?? 'Google login failed');
          }
        })
        .catch(() => {
          onError?.('Failed to fetch Google user info');
        });
    },
    onError: () => {
      onError?.('Google login failed');
    },
  });

  const buttonStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.75rem',
    width: '100%',
    padding: '0.75rem 1rem',
    border: 'none',
    borderRadius: '8px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    backgroundColor: config.backgroundColor,
    color: config.textColor,
    transition: 'opacity 0.2s, transform 0.1s',
  };

  const iconStyle: CSSProperties = {
    fontSize: '1.25rem',
    width: '1.25rem',
    textAlign: 'center',
    fontWeight: 700,
  };

  return (
    <button
      className={buttonClassName}
      style={buttonStyle}
      onClick={() => googleLogin()}
      onMouseOver={(event) => (event.currentTarget.style.opacity = '0.9')}
      onMouseOut={(event) => (event.currentTarget.style.opacity = '1')}
      onMouseDown={(event) => (event.currentTarget.style.transform = 'scale(0.98)')}
      onMouseUp={(event) => (event.currentTarget.style.transform = 'scale(1)')}
    >
      {renderIcon ? (
        renderIcon('google', config)
      ) : (
        <span style={iconStyle}>G</span>
      )}
      <span style={{ flex: 1, textAlign: 'left' }}>Sign in with {config.displayName}</span>
    </button>
  );
}

export function SignInButtons({
  onError,
  onProviderClick,
  className,
  buttonClassName,
  style,
  renderIcon,
}: SignInButtonsProps) {
  const { enabledProviders } = useSign();

  const handleProviderClick = (providerID: OAuthProviderID) => {
    if (onProviderClick) {
      onProviderClick(providerID);
    } else {
      console.log(`${providerID} login clicked - implement onProviderClick to handle`);
    }
  };

  const renderProviderButton = (providerID: OAuthProviderID) => {
    const config = PROVIDER_DISPLAY_CONFIGURATIONS[providerID];

    // Google uses custom button with useGoogleLogin hook
    if (providerID === 'google') {
      return (
        <GoogleSignInButton
          key={providerID}
          onError={(error) => onError?.(error, 'google')}
          buttonClassName={buttonClassName}
          renderIcon={renderIcon}
        />
      );
    }

    // Other providers use custom button
    const buttonStyle: CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '0.75rem',
      width: '100%',
      padding: '0.75rem 1rem',
      border: 'none',
      borderRadius: '8px',
      fontSize: '0.875rem',
      fontWeight: 500,
      cursor: 'pointer',
      backgroundColor: config.backgroundColor,
      color: config.textColor,
      transition: 'opacity 0.2s, transform 0.1s',
    };

    const iconStyle: CSSProperties = {
      fontSize: '1.25rem',
      width: '1.25rem',
      textAlign: 'center',
      fontWeight: 700,
    };

    return (
      <button
        key={providerID}
        className={buttonClassName}
        style={buttonStyle}
        onClick={() => handleProviderClick(providerID)}
        onMouseOver={(e) => (e.currentTarget.style.opacity = '0.9')}
        onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')}
        onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
      >
        {renderIcon ? (
          renderIcon(providerID, config)
        ) : config.iconType === 'text' ? (
          <span style={iconStyle}>{config.iconText}</span>
        ) : (
          <span style={iconStyle}>{config.displayName[0]}</span>
        )}
        <span style={{ flex: 1, textAlign: 'left' }}>Sign in with {config.displayName}</span>
      </button>
    );
  };

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', ...style }}>
      {enabledProviders.map(renderProviderButton)}
    </div>
  );
}
