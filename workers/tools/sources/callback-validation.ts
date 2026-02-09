import type { Logger } from '@audio-underview/logger';
import type { BaseEnvironment } from './types.ts';
import { redirectToFrontendWithError } from './responses.ts';

export interface CallbackParameters {
  code: string;
  state: string;
}

export type CallbackValidationResult =
  | { success: true; parameters: CallbackParameters }
  | { success: false; response: Response };

export function validateCallbackParameters(
  url: URL,
  frontendURL: string,
  provider: string,
  logger: Logger
): CallbackValidationResult {
  const error = url.searchParams.get('error');
  if (error) {
    const errorDescription = url.searchParams.get('error_description') ?? 'Unknown error';
    logger.error(`${provider} returned error`, new Error(error), {
      function: 'handleCallback',
      metadata: { error, errorDescription },
    });
    return {
      success: false,
      response: redirectToFrontendWithError(frontendURL, error, errorDescription),
    };
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    logger.error('Missing code or state parameter', undefined, {
      function: 'handleCallback',
      metadata: { hasCode: !!code, hasState: !!state },
    });
    return {
      success: false,
      response: redirectToFrontendWithError(
        frontendURL,
        'invalid_request',
        'Missing code or state parameter'
      ),
    };
  }

  return { success: true, parameters: { code, state } };
}

export async function verifyState(
  state: string,
  kvNamespace: KVNamespace,
  frontendURL: string,
  logger: Logger
): Promise<{ success: true; storedValue: string } | { success: false; response: Response }> {
  const storedValue = await kvNamespace.get(state);
  if (!storedValue) {
    logger.error('Invalid or expired state parameter', undefined, {
      function: 'handleCallback',
      metadata: { statePrefix: state.substring(0, 8) },
    });
    return {
      success: false,
      response: redirectToFrontendWithError(
        frontendURL,
        'invalid_state',
        'Invalid or expired state parameter'
      ),
    };
  }

  logger.debug('State verified successfully', undefined, { function: 'handleCallback' });

  await kvNamespace.delete(state);

  return { success: true, storedValue };
}
