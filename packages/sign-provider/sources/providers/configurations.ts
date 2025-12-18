import type { OAuthProviderID } from '../types/index.ts';

/**
 * Base provider display configuration
 */
interface ProviderDisplayConfigurationBase {
  providerID: OAuthProviderID;
  displayName: string;
  backgroundColor: string;
  textColor: string;
}

/**
 * FontAwesome icon configuration
 */
interface FontAwesomeIconConfiguration extends ProviderDisplayConfigurationBase {
  iconType: 'fontawesome';
  iconName: string;
}

/**
 * Custom icon configuration
 */
interface CustomIconConfiguration extends ProviderDisplayConfigurationBase {
  iconType: 'custom';
  iconName?: string;
}

/**
 * Text icon configuration
 */
interface TextIconConfiguration extends ProviderDisplayConfigurationBase {
  iconType: 'text';
  iconText: string;
}

/**
 * Provider display configuration (discriminated union)
 */
export type ProviderDisplayConfiguration =
  | FontAwesomeIconConfiguration
  | CustomIconConfiguration
  | TextIconConfiguration;

/**
 * All supported provider display configurations
 */
export const PROVIDER_DISPLAY_CONFIGURATIONS: Record<OAuthProviderID, ProviderDisplayConfiguration> = {
  google: {
    providerID: 'google',
    displayName: 'Google',
    backgroundColor: '#FFFFFF',
    textColor: '#757575',
    iconType: 'custom',
  },
  apple: {
    providerID: 'apple',
    displayName: 'Apple',
    backgroundColor: '#000000',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faApple',
  },
  microsoft: {
    providerID: 'microsoft',
    displayName: 'Microsoft',
    backgroundColor: '#00A4EF',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faMicrosoft',
  },
  facebook: {
    providerID: 'facebook',
    displayName: 'Facebook',
    backgroundColor: '#1877F2',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faFacebook',
  },
  github: {
    providerID: 'github',
    displayName: 'GitHub',
    backgroundColor: '#333333',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faGithub',
  },
  x: {
    providerID: 'x',
    displayName: 'X',
    backgroundColor: '#000000',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faXTwitter',
  },
  linkedin: {
    providerID: 'linkedin',
    displayName: 'LinkedIn',
    backgroundColor: '#0A66C2',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faLinkedin',
  },
  discord: {
    providerID: 'discord',
    displayName: 'Discord',
    backgroundColor: '#5865F2',
    textColor: '#FFFFFF',
    iconType: 'fontawesome',
    iconName: 'faDiscord',
  },
  kakao: {
    providerID: 'kakao',
    displayName: 'Kakao',
    backgroundColor: '#FEE500',
    textColor: '#000000',
    iconType: 'text',
    iconText: 'K',
  },
  naver: {
    providerID: 'naver',
    displayName: 'Naver',
    backgroundColor: '#03C75A',
    textColor: '#FFFFFF',
    iconType: 'text',
    iconText: 'N',
  },
};

/**
 * Get provider display configuration by ID
 */
export function getProviderDisplayConfiguration(
  providerID: OAuthProviderID
): ProviderDisplayConfiguration {
  return PROVIDER_DISPLAY_CONFIGURATIONS[providerID];
}
