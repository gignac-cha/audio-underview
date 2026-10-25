/**
 * The page's three states, driven through the real fetch path.
 *
 * The invalid-link case matters most: a 404 must produce the "no longer valid"
 * screen, and it must look identical whether the token was revoked or never
 * existed — the worker deliberately does not distinguish them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { renderWithTheme } from '../tests/render-with-theme.tsx';
import { SharePage } from './SharePage.tsx';
import { SAMPLE_SHARE_VIEW } from '../fixtures/sample-share-view.ts';

function renderAtToken(token = 'token-abc') {
  return renderWithTheme(
    <MemoryRouter initialEntries={[`/share/${token}`]}>
      <Routes>
        <Route path="/share/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function stubFetch(implementation: (input: string) => Promise<Response>) {
  const spy = vi.fn((input: RequestInfo | URL) => implementation(String(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SharePage', () => {
  it('shows a skeleton while the payload is in flight', () => {
    stubFetch(() => new Promise<Response>(() => undefined));

    renderAtToken();

    expect(screen.getByLabelText('불러오는 중')).toBeInTheDocument();
  });

  it('shapes the skeleton like the page it is standing in for', () => {
    stubFetch(() => new Promise<Response>(() => undefined));

    renderAtToken();

    // Hero card, title, byline, and a block of transcript lines — so nothing
    // jumps sideways when the payload lands.
    expect(screen.getByTestId('skeleton-hero')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-lines').childElementCount).toBeGreaterThan(3);
  });

  it('requests the share endpoint on the configured worker origin', async () => {
    const spy = stubFetch(() => jsonResponse(SAMPLE_SHARE_VIEW));

    renderAtToken('token-abc');

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toBe('https://worker.test/share/token-abc');
  });

  it('renders the newscast, its audio source, and the share badge', async () => {
    stubFetch(() => jsonResponse(SAMPLE_SHARE_VIEW));

    renderAtToken();

    expect(
      await screen.findByRole('heading', { name: '이해가 새로운 병목이다' }),
    ).toBeInTheDocument();
    expect(screen.getByText('공유된 뉴스캐스트')).toBeInTheDocument();
    expect(screen.getByTestId('share-audio')).toHaveAttribute(
      'src',
      'https://worker.test/share/token-abc/audio?part=1',
    );
    expect(document.title).toBe('이해가 새로운 병목이다 — Audio Underview');
  });

  it('shows the invalid-link screen on 404', async () => {
    stubFetch(() => jsonResponse({}, 404));

    renderAtToken('revoked-token');

    expect(
      await screen.findByRole('heading', { name: '이 링크는 더 이상 유효하지 않습니다' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('share-audio')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Audio Underview에서 뉴스캐스트 만들기' }),
    ).not.toBeInTheDocument();
  });

  it('keeps a transport failure distinct from a revoked link', async () => {
    stubFetch(() => Promise.reject(new Error('network down')));

    renderAtToken();

    expect(
      await screen.findByRole('heading', { name: '지금은 불러올 수 없습니다' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: '이 링크는 더 이상 유효하지 않습니다' }),
    ).not.toBeInTheDocument();
  });

  it('never renders a metadata card when the sharer opted into nothing', async () => {
    stubFetch(() => jsonResponse({ ...SAMPLE_SHARE_VIEW, metadata: {} }));

    renderAtToken();

    await screen.findByRole('heading', { name: '이해가 새로운 병목이다' });
    expect(screen.queryByLabelText('공개된 정보')).not.toBeInTheDocument();
  });

  it('refuses to mount the player for a payload with no parts', async () => {
    stubFetch(() => jsonResponse({ ...SAMPLE_SHARE_VIEW, parts: [] }));

    renderAtToken();

    expect(
      await screen.findByRole('heading', { name: '재생할 내용이 없습니다' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('share-audio')).not.toBeInTheDocument();
  });

  it('renders the metadata card when at least one field is public', async () => {
    stubFetch(() => jsonResponse(SAMPLE_SHARE_VIEW));

    renderAtToken();

    expect(await screen.findByLabelText('공개된 정보')).toBeInTheDocument();
  });
});
