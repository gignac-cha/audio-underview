import { loadAuthenticationData } from '@audio-underview/sign-provider';

/**
 * Requests to the newscast worker, the same way scheduler-manager-request.ts sends them: the base
 * URL from the environment, the Bearer token of the signed-in user and the server's own error text.
 */

export const NEWSCAST_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

export function hasAccessToken(): boolean {
  return !!loadAuthenticationData()?.credential;
}

function getAccessToken(): string {
  const authenticationData = loadAuthenticationData();
  if (!authenticationData) {
    throw new Error('Authentication required. Please sign in.');
  }
  return authenticationData.credential;
}

/**
 * The base URL of the newscast worker. Also what the audio URLs are built on, which is why it is
 * exported.
 */
export function getNewscastWorkerURL(): string {
  const baseURL = import.meta.env.VITE_NEWSCAST_WORKER_URL;
  if (!baseURL) {
    throw new Error('Service is not available. Please try again later.');
  }
  return baseURL;
}

export function throwResponseError(body: unknown, status: number): never {
  const record = body as Record<string, unknown> | null | undefined;
  const errorMessage = record?.error_description ?? record?.error ?? `Request failed with status ${status}`;
  throw new Error(String(errorMessage));
}

export async function parseResponseJSON(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Request failed with status ${response.status}`);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMilliseconds?: number;
}

/**
 * Sends the request and answers the response as it is, whatever its status.
 */
export async function fetchNewscastWorker(path: string, options: RequestOptions = {}): Promise<Response> {
  const baseURL = getNewscastWorkerURL();
  const accessToken = getAccessToken();

  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(`${baseURL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMilliseconds ?? NEWSCAST_REQUEST_TIMEOUT_MILLISECONDS),
  });
}

/**
 * Sends the request and answers the JSON body of a 2xx response; any other status throws the
 * error_description of the response.
 */
export async function requestNewscastWorkerJSON(path: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await fetchNewscastWorker(path, options);
  const body = await parseResponseJSON(response);
  if (!response.ok) {
    throwResponseError(body, response.status);
  }
  return body;
}
