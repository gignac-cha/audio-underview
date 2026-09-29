import type { OAuthProviderID } from '@audio-underview/sign-provider';

export const BLUESKY_PROVIDER_ID: OAuthProviderID = 'bluesky';
export const BLUESKY_DISPLAY_NAME = 'Bluesky';

/**
 * AT Protocol OAuth has no single authorization server: every account's PDS
 * names its own through `/.well-known/oauth-protected-resource`, so a login
 * re-reads the endpoints from that server's metadata. These are the values the
 * `bsky.social` entryway (which hosts most accounts) publishes, kept as the
 * provider defaults.
 */
export const BLUESKY_AUTHORIZATION_ENDPOINT = 'https://bsky.social/oauth/authorize';
export const BLUESKY_TOKEN_ENDPOINT = 'https://bsky.social/oauth/token';
export const BLUESKY_PUSHED_AUTHORIZATION_REQUEST_ENDPOINT = 'https://bsky.social/oauth/par';

/**
 * `com.atproto.server.getSession` is served by the account's own PDS, whose
 * origin is only known once the DID document has been resolved.
 */
export const BLUESKY_USER_INFO_PATH = '/xrpc/com.atproto.server.getSession';

export const BLUESKY_HANDLE_RESOLUTION_ENDPOINT =
  'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle';
export const BLUESKY_PLC_DIRECTORY_URL = 'https://plc.directory';
export const BLUESKY_PROTECTED_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const BLUESKY_AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';

/** Paths the worker serves so authorization servers can register it. */
export const BLUESKY_CLIENT_METADATA_PATH = '/oauth-client-metadata.json';
export const BLUESKY_JWKS_PATH = '/jwks.json';
export const BLUESKY_CALLBACK_PATH = '/callback';

/**
 * `atproto` is mandatory for every atproto session; `transition:email` adds the
 * account email to the getSession response.
 */
export const BLUESKY_DEFAULT_SCOPES = ['atproto', 'transition:email'];

export const BLUESKY_CLIENT_NAME = 'Audio Underview';
export const BLUESKY_SIGNING_ALGORITHM = 'ES256';
export const BLUESKY_CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface BlueskyOAuthConfiguration {
  clientID: string;
  redirectURI?: string;
  scopes?: string[];
}
