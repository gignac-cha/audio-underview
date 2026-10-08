import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { NoticeRegion } from './NoticeRegion.tsx';
import { clearNotices, getNotices, showNotice } from '../notice-store.ts';
import { noticeVisibleMilliseconds } from '../tokens.ts';

describe('NoticeRegion', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearNotices();
  });

  test('renders nothing while there are no notices', async () => {
    const screen = await render(<NoticeRegion />);

    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  });

  test('shows a raised notice as an alert with its title and description', async () => {
    await render(<NoticeRegion />);

    showNotice({ title: '로그인을 시작하지 못했습니다', description: '잠시 후 다시 시도해주세요.' });

    const alert = page.getByRole('alert');
    await expect.element(alert).toHaveTextContent('로그인을 시작하지 못했습니다');
    await expect.element(alert).toHaveTextContent('잠시 후 다시 시도해주세요.');
  });

  test('shows a notice raised before it was mounted, as after a route change', async () => {
    showNotice({ title: '로그인 실패', description: '로그인에 실패했습니다.' });

    await render(<NoticeRegion />);

    await expect.element(page.getByRole('alert')).toHaveTextContent('로그인 실패');
  });

  test('closes a notice with its close button', async () => {
    await render(<NoticeRegion />);
    showNotice({ title: '세션이 만료되었습니다', description: '다시 로그인해주세요.' });

    await page.getByRole('button', { name: '알림 닫기' }).click();

    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
    expect(getNotices()).toEqual([]);
  });

  test('closes a notice by itself after the visible time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    showNotice({ title: '로그인 실패' });
    await render(<NoticeRegion />);

    vi.advanceTimersByTime(noticeVisibleMilliseconds);

    expect(getNotices()).toEqual([]);
  });
});
