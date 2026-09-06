import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { AuthenticationCallbackPage } from '../sources/pages/AuthenticationCallbackPage.tsx';
import { sessionAtom } from '../sources/state/session.ts';
import { testUser } from './fixtures.ts';
import { server, workerURLs } from './mocks/server.ts';
import { renderApp } from './test-utils.tsx';

const routes = [
  { path: '/authentication/callback', element: <AuthenticationCallbackPage /> },
  { path: '/home', element: <div>Home dashboard</div> },
  { path: '/sign/in', element: <div>Sign in screen</div> },
];

const tokenResponse = {
  access_token: 'exchanged-access',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'exchanged-refresh',
  user: testUser,
};

describe('AuthenticationCallbackPage', () => {
  it('exchanges the authorization code and stores the session', async () => {
    let exchangeBody: unknown;
    server.use(
      http.post(`${workerURLs.authentication}/tokens`, async ({ request }) => {
        exchangeBody = await request.json();
        return HttpResponse.json(tokenResponse);
      }),
    );

    const { store } = renderApp({
      routes,
      initialEntries: ['/authentication/callback?code=auth-code-123&provider=google'],
    });

    expect(await screen.findByText('Home dashboard')).toBeInTheDocument();
    expect(exchangeBody).toEqual({ grant_type: 'authorization_code', code: 'auth-code-123' });
    expect(store.get(sessionAtom)?.accessToken).toBe('exchanged-access');
  });

  it('redirects to sign-in when the provider returns an error', async () => {
    const { store } = renderApp({
      routes,
      initialEntries: ['/authentication/callback?error=access_denied&error_description=No'],
    });

    expect(await screen.findByText('Sign in screen')).toBeInTheDocument();
    expect(store.get(sessionAtom)).toBeNull();
  });

  it('redirects to sign-in when the token exchange fails', async () => {
    server.use(
      http.post(`${workerURLs.authentication}/tokens`, () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
    );

    const { store } = renderApp({
      routes,
      initialEntries: ['/authentication/callback?code=bad-code'],
    });

    await waitFor(() => {
      expect(screen.getByText('Sign in screen')).toBeInTheDocument();
    });
    expect(store.get(sessionAtom)).toBeNull();
  });
});
