import type { OAuthProviderID } from '@audio-underview/sign-provider';

/**
 * `available`: the sign-in screen shows a button that starts signing in.
 * `preparing`: the sign-in screen lists the provider as not ready yet.
 */
export type ProviderStatus = 'available' | 'preparing';

/**
 * Sign-in status of every provider, written in the order the sign-in screen
 * lists them. Typed as a `Record` so adding an `OAuthProviderID` fails
 * typecheck until its status is set here.
 */
export const PROVIDER_STATUSES: Record<OAuthProviderID, ProviderStatus> = {
  google: 'available',
  github: 'available',
  apple: 'preparing',
  microsoft: 'preparing',
  facebook: 'preparing',
  x: 'preparing',
  linkedin: 'preparing',
  discord: 'preparing',
  kakao: 'preparing',
  naver: 'preparing',
  threads: 'preparing',
  tiktok: 'preparing',
  line: 'preparing',
  bluesky: 'preparing',
  twitch: 'preparing',
};

/** Every provider in display order (string keys keep their insertion order). */
export const ORDERED_PROVIDERS = Object.keys(PROVIDER_STATUSES) as OAuthProviderID[];

/** Providers a person can sign in with now. `AuthenticationProvider` receives this list. */
export const AVAILABLE_PROVIDERS: OAuthProviderID[] = ORDERED_PROVIDERS.filter(
  (providerID) => PROVIDER_STATUSES[providerID] === 'available',
);

export const PREPARING_PROVIDERS: OAuthProviderID[] = ORDERED_PROVIDERS.filter(
  (providerID) => PROVIDER_STATUSES[providerID] === 'preparing',
);
