import { http, HttpResponse } from 'msw';
import { test, expect } from '../tests/extensions.ts';
import { worker } from '../tests/mocks/browser.ts';
import { getNewscastWorkerURL, requestNewscastWorkerJSON } from './newscast-request.ts';

const NEWSCAST_URL = 'http://localhost:6666';

vi.mock('@audio-underview/sign-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@audio-underview/sign-provider')>();
  return {
    ...actual,
    loadAuthenticationData: vi.fn(() => ({
      user: { id: 'u1', name: 'Test', email: 'test@example.com', provider: 'google' },
      credential: 'test-access-token',
      expiresAt: Date.now() + 3_600_000,
    })),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('newscast-request', () => {
  test('throws when VITE_NEWSCAST_WORKER_URL is not set, like the other request helpers', async () => {
    vi.stubEnv('VITE_NEWSCAST_WORKER_URL', '');

    expect(() => getNewscastWorkerURL()).toThrow('Service is not available. Please try again later.');
    await expect(requestNewscastWorkerJSON('/newscasts')).rejects.toThrow('Service is not available. Please try again later.');
  });

  test('sends the Bearer token and a JSON body, and throws the error_description of a failure', async () => {
    vi.stubEnv('VITE_NEWSCAST_WORKER_URL', NEWSCAST_URL);
    const received: { authorization: string | null; contentType: string | null; body: unknown }[] = [];
    worker.use(
      http.post(`${NEWSCAST_URL}/newscasts/schedulers`, async ({ request }) => {
        received.push({
          authorization: request.headers.get('Authorization'),
          contentType: request.headers.get('Content-Type'),
          body: await request.json(),
        });
        return HttpResponse.json({ error: 'invalid_source', error_description: "source must be 'geeknews', 'url' or 'text'." }, { status: 400 });
      }),
    );

    await expect(requestNewscastWorkerJSON('/newscasts/schedulers', { method: 'POST', body: { source: 'rss' } })).rejects.toThrow(
      "source must be 'geeknews', 'url' or 'text'.",
    );
    expect(received).toEqual([{ authorization: 'Bearer test-access-token', contentType: 'application/json', body: { source: 'rss' } }]);
  });
});
