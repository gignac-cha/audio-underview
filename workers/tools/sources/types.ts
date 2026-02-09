import type { Logger } from '@audio-underview/logger';

export interface OAuthErrorResponse {
  error: string;
  errorDescription?: string;
}

export interface BaseEnvironment {
  FRONTEND_URL: string;
  ALLOWED_ORIGINS: string;
  AUDIO_UNDERVIEW_OAUTH_STATE: KVNamespace;
}

export interface OAuthWorkerHandlers<Environment extends BaseEnvironment> {
  handleAuthorize: (request: Request, environment: Environment) => Promise<Response>;
  handleCallback: (request: Request, environment: Environment) => Promise<Response>;
}

export interface OAuthWorkerOptions<Environment extends BaseEnvironment> {
  provider: string;
  logger: Logger;
  handlers: OAuthWorkerHandlers<Environment>;
}
