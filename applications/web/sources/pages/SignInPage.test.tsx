import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { page, userEvent } from 'vitest/browser';
import { oauthProviderID, PROVIDER_DISPLAY_CONFIGURATIONS, type OAuthProviderID } from '@audio-underview/sign-provider';
import { AuthenticationContext } from '../contexts/authentication-context-value.ts';
import type { AuthenticationContextValue } from '../contexts/authentication-context-value.ts';
import {
  AVAILABLE_PROVIDERS,
  ORDERED_PROVIDERS,
  PREPARING_PROVIDERS,
  PROVIDER_STATUSES,
} from '../constants/provider-statuses.ts';
import { clearNotices, getNotices } from '../design-system/notice-store.ts';
import { SignInPage } from './SignInPage.tsx';

const SPECIFIED_ORDER: OAuthProviderID[] = [
  'google',
  'github',
  'apple',
  'microsoft',
  'facebook',
  'x',
  'linkedin',
  'discord',
  'kakao',
  'naver',
  'threads',
  'tiktok',
  'line',
  'bluesky',
  'twitch',
];

function createAuthentication(overrides: Partial<AuthenticationContextValue> = {}): AuthenticationContextValue {
  return {
    user: undefined,
    isAuthenticated: false,
    isLoading: false,
    enabledProviders: AVAILABLE_PROVIDERS,
    isGoogleConfigured: true,
    isGitHubConfigured: true,
    loginWithGoogle: vi.fn(),
    loginWithGitHub: vi.fn(),
    loginWithProvider: vi.fn().mockReturnValue({ success: true }),
    logout: vi.fn(),
    ...overrides,
  };
}

async function renderSignInPage(overrides: Partial<AuthenticationContextValue> = {}) {
  const authentication = createAuthentication(overrides);
  const screen = await render(
    <AuthenticationContext.Provider value={authentication}>
      <MemoryRouter initialEntries={['/sign/in']}>
        <Routes>
          <Route path="/sign/in" element={<SignInPage />} />
          <Route path="/home" element={<p>홈 화면</p>} />
        </Routes>
      </MemoryRouter>
    </AuthenticationContext.Provider>,
  );
  return { authentication, screen };
}

function displayName(providerID: OAuthProviderID): string {
  return PROVIDER_DISPLAY_CONFIGURATIONS[providerID].displayName;
}

afterEach(() => {
  clearNotices();
});

describe('provider statuses', () => {
  test('holds every OAuthProviderID exactly once', () => {
    const keys = Object.keys(PROVIDER_STATUSES);

    expect(keys).toHaveLength(oauthProviderID.options.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...oauthProviderID.options].sort());
  });

  test('lists providers in the specified order with google and github available', () => {
    expect(ORDERED_PROVIDERS).toEqual(SPECIFIED_ORDER);
    expect(AVAILABLE_PROVIDERS).toEqual(['google', 'github']);
    expect(PREPARING_PROVIDERS).toEqual(SPECIFIED_ORDER.slice(2));
  });
});

describe('SignInPage', () => {
  test('shows the service name and introduction', async () => {
    await renderSignInPage();

    await expect.element(page.getByRole('heading', { level: 1, name: 'Audio Underview' })).toBeVisible();
    await expect.element(page.getByText('웹에서 모은 소식을 오디오 뉴스캐스트로 듣습니다')).toBeVisible();
  });

  test('shows all 15 providers in the specified order', async () => {
    const { screen } = await renderSignInPage();
    await expect.element(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();

    const buttons = page.getByRole('button').elements();
    expect(buttons.map((button) => button.textContent)).toEqual(['Google로 계속하기', 'GitHub로 계속하기']);

    const preparingItems = page.getByRole('region', { name: '준비 중인 로그인' }).getByRole('listitem').elements();
    expect(preparingItems).toHaveLength(13);

    const renderedOrder = Array.from(screen.container.querySelectorAll('main button, main section li')).map(
      (element) => (element.textContent ?? '').replace('로 계속하기', '').replace('준비 중', '').trim(),
    );
    expect(renderedOrder).toEqual(SPECIFIED_ORDER.map(displayName));
  });

  test('starts Google sign-in from "Google로 계속하기"', async () => {
    const { authentication } = await renderSignInPage();

    await page.getByRole('button', { name: 'Google로 계속하기' }).click();

    expect(authentication.loginWithGoogle).toHaveBeenCalledOnce();
    expect(authentication.loginWithGitHub).not.toHaveBeenCalled();
  });

  test('starts GitHub sign-in from "GitHub로 계속하기"', async () => {
    const { authentication } = await renderSignInPage();

    await page.getByRole('button', { name: 'GitHub로 계속하기' }).click();

    expect(authentication.loginWithGitHub).toHaveBeenCalledOnce();
    expect(authentication.loginWithGoogle).not.toHaveBeenCalled();
  });

  test('shows preparing providers as text, not buttons, marked 준비 중', async () => {
    await renderSignInPage();

    const preparingRegion = page.getByRole('region', { name: '준비 중인 로그인' });
    await expect.element(preparingRegion).toBeVisible();
    expect(preparingRegion.getByRole('button').elements()).toHaveLength(0);

    for (const providerID of PREPARING_PROVIDERS) {
      const name = displayName(providerID);
      expect(page.getByRole('button', { name }).elements()).toHaveLength(0);

      const item = preparingRegion.getByRole('listitem').filter({ hasText: new RegExp(`^${name}`) });
      await expect.element(item).toHaveTextContent('준비 중');
    }
  });

  test('keeps keyboard focus on the two sign-in buttons only', async () => {
    await renderSignInPage();
    await expect.element(page.getByRole('button', { name: 'Google로 계속하기' })).toBeVisible();

    const preparingRegion = page.getByRole('region', { name: '준비 중인 로그인' }).element();
    const focusedLabels: string[] = [];

    for (let step = 0; step < 4; step += 1) {
      await userEvent.tab();
      const active = document.activeElement;
      expect(preparingRegion.contains(active)).toBe(false);
      if (active instanceof HTMLButtonElement) {
        focusedLabels.push(active.textContent ?? '');
      }
    }

    expect(focusedLabels.slice(0, 2)).toEqual(['Google로 계속하기', 'GitHub로 계속하기']);
    expect(preparingRegion.querySelectorAll('[tabindex], a, button, input')).toHaveLength(0);
  });

  test('sends a signed-in person to /home', async () => {
    await renderSignInPage({
      isAuthenticated: true,
      user: { id: 'user-1', name: '김하늘', email: 'sky@example.com', provider: 'google' },
    });

    await expect.element(page.getByText('홈 화면')).toBeVisible();
    expect(page.getByRole('button', { name: 'Google로 계속하기' }).query()).toBeNull();
  });

  test.each([
    { label: 'Google로 계속하기', configuration: { isGoogleConfigured: false } },
    { label: 'GitHub로 계속하기', configuration: { isGitHubConfigured: false } },
  ])('shows an error notice and stays when the worker URL is missing ($label)', async ({ label, configuration }) => {
    const { authentication } = await renderSignInPage(configuration);

    await page.getByRole('button', { name: label }).click();

    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('로그인을 시작하지 못했습니다');
    await expect.element(alert).toHaveTextContent('잠시 후 다시 시도해주세요.');
    expect(getNotices()).toEqual([
      expect.objectContaining({
        tone: 'error',
        title: '로그인을 시작하지 못했습니다',
        description: '잠시 후 다시 시도해주세요.',
      }),
    ]);
    expect(authentication.loginWithGoogle).not.toHaveBeenCalled();
    expect(authentication.loginWithGitHub).not.toHaveBeenCalled();
    await expect.element(page.getByRole('heading', { level: 1, name: 'Audio Underview' })).toBeVisible();
  });
});
