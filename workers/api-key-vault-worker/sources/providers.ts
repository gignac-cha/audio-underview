import type { GatewayOptions } from './environment.ts';

export const PROVIDER_NAMES = ['anthropic', 'openai', 'google', 'xai'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderValidationRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProviderDefinition {
  origin: string;
  gatewaySegment: string;
  removesLeadingVersionBehindGateway: boolean;
  createAuthenticationHeaders(key: string): Record<string, string>;
  validationRequest: ProviderValidationRequest;
}

export const PROVIDER_DEFINITIONS: Readonly<Record<ProviderName, ProviderDefinition>> = {
  anthropic: {
    origin: 'https://api.anthropic.com',
    gatewaySegment: 'anthropic',
    removesLeadingVersionBehindGateway: false,
    createAuthenticationHeaders: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    }),
    validationRequest: {
      method: 'POST',
      path: 'v1/messages/count_tokens',
      headers: { 'content-type': 'application/json' },
      body: '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"ping"}]}',
    },
  },
  openai: {
    origin: 'https://api.openai.com',
    gatewaySegment: 'openai',
    removesLeadingVersionBehindGateway: true,
    createAuthenticationHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    validationRequest: { method: 'GET', path: 'v1/models', headers: {}, body: null },
  },
  google: {
    origin: 'https://generativelanguage.googleapis.com',
    gatewaySegment: 'google-ai-studio',
    removesLeadingVersionBehindGateway: false,
    createAuthenticationHeaders: (key) => ({ 'x-goog-api-key': key }),
    validationRequest: { method: 'GET', path: 'v1beta/models?pageSize=1', headers: {}, body: null },
  },
  xai: {
    origin: 'https://api.x.ai',
    gatewaySegment: 'grok',
    removesLeadingVersionBehindGateway: false,
    createAuthenticationHeaders: (key) => ({ authorization: `Bearer ${key}` }),
    validationRequest: { method: 'GET', path: 'v1/models', headers: {}, body: null },
  },
};

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PROVIDER_NAMES as readonly string[]).includes(value);
}

export type ProviderURLError = 'invalid_path' | 'blocked_origin';

export type ProviderURLResult =
  | { ok: true; url: string }
  | { ok: false; error: ProviderURLError };

const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ENCODED_SEPARATOR_PATTERN = /%2f|%5c/i;
const ENCODED_DOT_PATTERN = /%2e/gi;

function climbsAboveRoot(path: string): boolean {
  const withoutControlCharacters = path.replace(/[\t\n\r]/g, '');
  const pathPart = withoutControlCharacters.split(/[?#]/, 1)[0] ?? '';
  if (ENCODED_SEPARATOR_PATTERN.test(pathPart)) {
    return true;
  }
  return pathPart
    .split('/')
    .some((segment) => segment.replace(ENCODED_DOT_PATTERN, '.') === '..');
}

function isRejectedPath(path: string): boolean {
  return (
    path.length === 0 ||
    SCHEME_PATTERN.test(path) ||
    path.startsWith('//') ||
    path.includes('\\') ||
    climbsAboveRoot(path)
  );
}

function removeTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Builds the provider URL for a caller-supplied path. The origin always comes
 * from the provider table or the vault's own gateway setting, never from the caller.
 */
export function buildProviderURL(
  provider: ProviderName,
  path: string,
  gateway: GatewayOptions | null,
): ProviderURLResult {
  if (isRejectedPath(path)) {
    return { ok: false, error: 'invalid_path' };
  }

  const definition = PROVIDER_DEFINITIONS[provider];
  const relativePath = path.startsWith('/') ? path.slice(1) : path;

  let baseURL: URL;
  let joinedURL: string;
  let allowedPathnamePrefix: string;

  if (gateway === null) {
    try {
      baseURL = new URL(definition.origin);
    } catch {
      return { ok: false, error: 'blocked_origin' };
    }
    joinedURL = `${definition.origin}/${relativePath}`;
    allowedPathnamePrefix = '/';
  } else {
    const trimmedBase = removeTrailingSlashes(gateway.baseURL);
    try {
      baseURL = new URL(trimmedBase);
    } catch {
      return { ok: false, error: 'blocked_origin' };
    }
    const gatewayRelativePath =
      definition.removesLeadingVersionBehindGateway && relativePath.startsWith('v1/')
        ? relativePath.slice('v1/'.length)
        : relativePath;
    joinedURL = `${trimmedBase}/${definition.gatewaySegment}/${gatewayRelativePath}`;
    allowedPathnamePrefix = `${removeTrailingSlashes(baseURL.pathname)}/${definition.gatewaySegment}/`;
  }

  let completedURL: URL;
  try {
    completedURL = new URL(joinedURL);
  } catch {
    return { ok: false, error: 'invalid_path' };
  }

  if (completedURL.origin !== baseURL.origin) {
    return { ok: false, error: 'blocked_origin' };
  }

  if (!completedURL.pathname.startsWith(allowedPathnamePrefix)) {
    return { ok: false, error: 'invalid_path' };
  }

  return { ok: true, url: completedURL.toString() };
}

const FORWARDED_CALLER_HEADER_NAMES = new Set([
  'content-type',
  'accept',
  'anthropic-version',
  'anthropic-beta',
]);

/**
 * Keeps only the allow-listed caller headers, then lays the provider
 * authentication headers and finally the gateway token header over them.
 */
export function buildProviderHeaders(
  provider: ProviderName,
  key: string,
  callerHeaders: unknown,
  gateway: GatewayOptions | null,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (typeof callerHeaders === 'object' && callerHeaders !== null && !Array.isArray(callerHeaders)) {
    for (const [name, value] of Object.entries(callerHeaders)) {
      const lowerCaseName = name.toLowerCase();
      if (FORWARDED_CALLER_HEADER_NAMES.has(lowerCaseName) && typeof value === 'string') {
        headers[lowerCaseName] = value;
      }
    }
  }

  Object.assign(headers, PROVIDER_DEFINITIONS[provider].createAuthenticationHeaders(key));

  if (gateway !== null && gateway.token !== null) {
    headers['cf-aig-authorization'] = `Bearer ${gateway.token}`;
  }

  return headers;
}
