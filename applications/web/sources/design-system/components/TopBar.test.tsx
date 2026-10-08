import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { MemoryRouter } from 'react-router';
import { TopBar } from './TopBar.tsx';
import { TopBarAccount } from './TopBarAccount.tsx';

const NAVIGATION_ITEMS = [
  { label: '홈', path: '/home' },
  { label: '크롤러', path: '/crawlers' },
  { label: '스케줄러', path: '/schedulers' },
];

async function renderTopBar(onSignOut = vi.fn()) {
  await render(
    <MemoryRouter initialEntries={['/home']}>
      <TopBar
        serviceName="Audio Underview"
        homePath="/home"
        navigationLabel="주 메뉴"
        navigationItems={NAVIGATION_ITEMS}
        trailing={<TopBarAccount name="차진혁" signOutLabel="로그아웃" onSignOut={onSignOut} />}
      />
    </MemoryRouter>,
  );
  return { onSignOut };
}

/** Where the text itself starts and ends, not the padded box around it. */
function textEdges(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const box = range.getBoundingClientRect();
  return { left: box.left, right: box.right };
}

/** The bar's content edges: the page gutter on each side. */
function contentEdges(banner: Element) {
  const inner = banner.firstElementChild;
  if (inner === null) {
    throw new Error('The top bar has no inner row');
  }
  const box = inner.getBoundingClientRect();
  const style = getComputedStyle(inner);
  return { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) };
}

describe('TopBar', () => {
  test('uses header and nav landmarks', async () => {
    await renderTopBar();

    await expect.element(page.getByRole('banner')).toBeInTheDocument();
    await expect.element(page.getByRole('navigation', { name: '주 메뉴' })).toBeInTheDocument();
  });

  test('links the service name home and each menu item to its path', async () => {
    await renderTopBar();

    await expect.element(page.getByRole('link', { name: 'Audio Underview' })).toHaveAttribute('href', '/home');
    const navigation = page.getByRole('navigation', { name: '주 메뉴' });
    await expect.element(navigation.getByRole('link', { name: '홈' })).toHaveAttribute('href', '/home');
    await expect.element(navigation.getByRole('link', { name: '크롤러' })).toHaveAttribute('href', '/crawlers');
    await expect.element(navigation.getByRole('link', { name: '스케줄러' })).toHaveAttribute('href', '/schedulers');
  });

  test('marks the current page', async () => {
    await renderTopBar();

    const navigation = page.getByRole('navigation', { name: '주 메뉴' });
    await expect.element(navigation.getByRole('link', { name: '홈' })).toHaveAttribute('aria-current', 'page');
    await expect.element(navigation.getByRole('link', { name: '크롤러' })).not.toHaveAttribute('aria-current');
  });

  test('gives every menu item, even the one-character 홈, a tap target of at least 44px', async () => {
    await renderTopBar();

    const links = page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link');
    await expect.poll(() => links.elements()).toHaveLength(NAVIGATION_ITEMS.length);
    for (const link of links.elements()) {
      const box = link.getBoundingClientRect();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  describe.each([360, 768, 1280])('at %ipx wide', (width) => {
    let initialViewport: [number, number] = [0, 0];

    beforeEach(async () => {
      initialViewport = [window.innerWidth, window.innerHeight];
      await page.viewport(width, 800);
    });

    afterEach(async () => {
      await page.viewport(...initialViewport);
    });

    test('starts the service name label on the start gutter and ends the sign-out label on the end gutter', async () => {
      await renderTopBar();
      const signOut = page.getByRole('button', { name: '로그아웃' });
      await expect.element(signOut).toBeVisible();

      const gutter = contentEdges(page.getByRole('banner').element());
      expect(textEdges(page.getByRole('link', { name: 'Audio Underview' }).element()).left).toBeCloseTo(gutter.left, 0);
      expect(textEdges(signOut.element()).right).toBeCloseTo(gutter.right, 0);

      const signOutBox = signOut.element().getBoundingClientRect();
      expect(signOutBox.width).toBeGreaterThanOrEqual(44);
      expect(signOutBox.height).toBeGreaterThanOrEqual(44);
    });
  });

  test('below 768px, starts the first menu label on the gutter and keeps the current-page bar inside it', async () => {
    const initialViewport: [number, number] = [window.innerWidth, window.innerHeight];
    await page.viewport(360, 800);
    try {
      await renderTopBar();
      const home = page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '홈' });
      await expect.element(home).toBeVisible();

      const gutter = contentEdges(page.getByRole('banner').element());
      const label = home.element().querySelector('[data-navigation-label]');
      if (label === null) {
        throw new Error('The menu item has no label element');
      }
      expect(textEdges(home.element()).left).toBeCloseTo(gutter.left, 0);
      const barLeft = label.getBoundingClientRect().left + parseFloat(getComputedStyle(label, '::after').left);
      expect(barLeft).toBeGreaterThanOrEqual(gutter.left - 0.5);
      expect(home.element().getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    } finally {
      await page.viewport(...initialViewport);
    }
  });

  test('shows the account name and signs out from the account area', async () => {
    const { onSignOut } = await renderTopBar();

    await expect.element(page.getByText('차진혁')).toBeInTheDocument();
    await page.getByRole('button', { name: '로그아웃' }).click();

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
