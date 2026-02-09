import type { ReactNode, CSSProperties } from 'react';
import {
  useAuthentication,
  PROVIDER_DISPLAY_CONFIGURATIONS,
  type OAuthProviderID,
  type ProviderDisplayConfiguration,
} from '../contexts/AuthenticationContext.tsx';

export interface SignInButtonsProps {
  onError?: (error: string, providerID: OAuthProviderID) => void;
  onProviderClick?: (providerID: OAuthProviderID) => void;
  className?: string;
  buttonClassName?: string;
  style?: CSSProperties;
  renderIcon?: (providerID: OAuthProviderID, configuration: ProviderDisplayConfiguration) => ReactNode;
}

export function SignInButtons({
  onError: _onError,
  onProviderClick,
  className,
  buttonClassName,
  style,
  renderIcon,
}: SignInButtonsProps) {
  const { enabledProviders, loginWithGoogle, loginWithGitHub } = useAuthentication();

  const handleProviderClick = (providerID: OAuthProviderID) => {
    if (providerID === 'google') {
      loginWithGoogle();
      return;
    }

    if (providerID === 'github') {
      loginWithGitHub();
      return;
    }

    if (onProviderClick) {
      onProviderClick(providerID);
    } else {
      console.log(`${providerID} login clicked - implement onProviderClick to handle`);
    }
  };

  const renderProviderButton = (providerID: OAuthProviderID) => {
    const configuration = PROVIDER_DISPLAY_CONFIGURATIONS[providerID];

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
      backgroundColor: configuration.backgroundColor,
      color: configuration.textColor,
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
        onMouseOver={(event) => (event.currentTarget.style.opacity = '0.9')}
        onMouseOut={(event) => (event.currentTarget.style.opacity = '1')}
        onMouseDown={(event) => (event.currentTarget.style.transform = 'scale(0.98)')}
        onMouseUp={(event) => (event.currentTarget.style.transform = 'scale(1)')}
      >
        {renderIcon ? (
          renderIcon(providerID, configuration)
        ) : configuration.iconType === 'text' ? (
          <span style={iconStyle}>{configuration.iconText}</span>
        ) : (
          <span style={iconStyle}>{configuration.displayName[0]}</span>
        )}
        <span style={{ flex: 1, textAlign: 'left' }}>Sign in with {configuration.displayName}</span>
      </button>
    );
  };

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', ...style }}>
      {enabledProviders.map(renderProviderButton)}
    </div>
  );
}
