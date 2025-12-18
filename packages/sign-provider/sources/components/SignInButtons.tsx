import type { ReactNode, CSSProperties } from 'react';
import { GoogleLogin } from '@react-oauth/google';
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

export function SignInButtons({
  onError,
  onProviderClick,
  className,
  buttonClassName,
  style,
  renderIcon,
}: SignInButtonsProps) {
  const { enabledProviders, loginWithGoogle } = useSign();

  const handleGoogleSuccess = (credentialResponse: Parameters<typeof loginWithGoogle>[0]) => {
    const result = loginWithGoogle(credentialResponse);
    if (!result.success) {
      onError?.(result.error ?? 'Google login failed', 'google');
    }
  };

  const handleGoogleError = () => {
    onError?.('Google login failed', 'google');
  };

  const handleProviderClick = (providerID: OAuthProviderID) => {
    if (onProviderClick) {
      onProviderClick(providerID);
    } else {
      console.log(`${providerID} login clicked - implement onProviderClick to handle`);
    }
  };

  const renderProviderButton = (providerID: OAuthProviderID) => {
    const config = PROVIDER_DISPLAY_CONFIGURATIONS[providerID];

    // Google uses GoogleLogin component
    if (providerID === 'google') {
      return (
        <div key={providerID} className={buttonClassName}>
          <GoogleLogin
            onSuccess={handleGoogleSuccess}
            onError={handleGoogleError}
            theme="outline"
            size="large"
            shape="rectangular"
            text="signin_with"
            width="100%"
          />
        </div>
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
