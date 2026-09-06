import type {
  OAuthTokenResponse,
  ProviderConfiguration,
} from '@audio-underview/authentication-core';

export const testConfiguration: ProviderConfiguration = {
  clientID: 'client-1',
  clientSecret: 'secret-1',
};

export const testTokens: OAuthTokenResponse = {
  accessToken: 'access-token-1',
};

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export interface FakeResponse {
  status?: number;
  payload: unknown;
}

/** 요청을 기록하고 URL별 JSON 응답을 돌려주는 fake fetch. */
export const createRecordingFetch = (
  respond: (url: URL) => FakeResponse,
): { fetchImplementation: typeof fetch; requests: RecordedRequest[] } => {
  const requests: RecordedRequest[] = [];
  const fetchImplementation = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const { status, payload } = respond(url);
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { fetchImplementation, requests };
};
