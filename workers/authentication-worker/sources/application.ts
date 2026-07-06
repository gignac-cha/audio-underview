import {
  createWorkerRouter,
  jsonResponse,
  type WorkerRouter,
} from '@audio-underview/worker-foundation';
import type { WorkerEnvironment } from './environment.ts';
import { handleAuthorize } from './handlers/authorize.ts';
import { handleCallback, type CallbackDependencies } from './handlers/callback.ts';
import { handleTokens } from './handlers/tokens.ts';
import { listEnabledProviders } from './provider-configurations.ts';

export const SERVICE_NAME = 'audio-underview-authentication-worker';

const PROVIDER_PATTERN = /^[a-z]+$/;

export const createAuthenticationRouter = (
  dependencies: CallbackDependencies = {},
): WorkerRouter<WorkerEnvironment> =>
  createWorkerRouter<WorkerEnvironment>({
    serviceName: SERVICE_NAME,
    help: [
      { method: 'GET', path: '/', description: 'Service help' },
      { method: 'GET', path: '/providers', description: 'List enabled providers' },
      { method: 'GET', path: '/providers/:provider/authorize', description: 'Start an OAuth flow' },
      { method: 'GET', path: '/providers/:provider/callback', description: 'OAuth callback' },
      { method: 'POST', path: '/tokens', description: 'Exchange or refresh tokens' },
    ],
    cors: {
      allowMethods: 'GET, POST, OPTIONS',
      allowHeaders: 'Content-Type',
    },
    resolveAllowedOrigins: (environment) => environment.ALLOWED_ORIGINS,
    routes: [
      {
        method: 'GET',
        pattern: '/providers',
        handler: (context) =>
          jsonResponse(
            { providers: listEnabledProviders(context.environment) },
            200,
            context.responseContext,
          ),
      },
      {
        method: 'GET',
        pattern: '/providers/:provider/authorize',
        parameterPatterns: { provider: PROVIDER_PATTERN },
        handler: (context) => handleAuthorize(context),
      },
      {
        method: 'GET',
        pattern: '/providers/:provider/callback',
        parameterPatterns: { provider: PROVIDER_PATTERN },
        handler: (context) => handleCallback(context, dependencies),
      },
      {
        // apple form_post — POST callback (스펙 §6 apple)
        method: 'POST',
        pattern: '/providers/:provider/callback',
        parameterPatterns: { provider: PROVIDER_PATTERN },
        handler: (context) => handleCallback(context, dependencies),
      },
      {
        method: 'POST',
        pattern: '/tokens',
        handler: (context) => handleTokens(context),
      },
    ],
  });
