import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { test, expect } from '../../tests/extensions.ts';
import { CrawlerSubmissionDialog } from './CrawlerSubmissionDialog.tsx';
import { ToastProvider } from '../../contexts/ToastContext.tsx';
import { worker } from '../../tests/mocks/browser.ts';
import { page } from '@vitest/browser/context';
import type { ReactNode } from 'react';

const MANAGER_URL = 'http://localhost:8888';

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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ToastProvider>{children}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('CrawlerSubmissionDialog', () => {
  test('renders dialog title and description when open', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    await expect.element(page.getByRole('heading', { name: 'Submit Crawler' })).toBeVisible();
    await expect.element(page.getByText(/Give your crawler a name/)).toBeVisible();
  });

  test('renders input fields and buttons', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    await expect.element(page.getByPlaceholder('My Crawler')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Submit' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  });

  test('shows pattern match preview when URL and pattern match', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com/posts/1" code="return {}" />,
      { wrapper: createWrapper() },
    );

    const textboxes = page.getByRole('textbox');
    const patternInput = textboxes.nth(1);
    await patternInput.fill('^https://example\\.com');

    await expect.element(page.getByText('Pattern matches the test URL')).toBeVisible();
  });

  test('shows non-matching preview for unmatched pattern', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    const textboxes = page.getByRole('textbox');
    const patternInput = textboxes.nth(1);
    await patternInput.fill('^https://other\\.com');

    await expect.element(page.getByText('Pattern does not match the test URL')).toBeVisible();
  });

  test('shows validation error when submitting without name', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    await page.getByRole('button', { name: 'Submit' }).click();

    await expect.element(page.getByText('Please enter a crawler name.')).toBeVisible();
  });

  test('shows validation error when submitting without URL pattern', async () => {
    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={vi.fn()} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    await page.getByPlaceholder('My Crawler').fill('Test Crawler');

    await page.getByRole('button', { name: 'Submit' }).click();

    await expect.element(page.getByText('Please enter a URL pattern.')).toBeVisible();
  });

  test('submits successfully and shows success toast', async () => {
    const onOpenChange = vi.fn();
    worker.use(
      http.post(`${MANAGER_URL}/crawlers`, async () => {
        return HttpResponse.json({
          id: 'c1', name: 'Test Crawler', url_pattern: '^https://example\\.com',
          code: 'return {}', user_id: 'u1', created_at: '2024-01-01',
        });
      }),
    );

    await render(
      <CrawlerSubmissionDialog open={true} onOpenChange={onOpenChange} url="https://example.com" code="return {}" />,
      { wrapper: createWrapper() },
    );

    await page.getByPlaceholder('My Crawler').fill('Test Crawler');

    const textboxes = page.getByRole('textbox');
    const patternInput = textboxes.nth(1);
    await patternInput.fill('^https://example\\.com');

    await page.getByRole('button', { name: 'Submit' }).click();

    await expect.element(page.getByText('Crawler saved successfully.')).toBeVisible();
  });
});
