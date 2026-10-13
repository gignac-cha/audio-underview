import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import indexHTML from '../../../index.html?raw';
import { PageLayout, MAIN_CONTENT_ID, EARLY_CANVAS_ATTRIBUTE } from './PageLayout.tsx';
import { clearNotices, showNotice } from '../notice-store.ts';
import { lightTheme } from '../tokens.ts';

describe('PageLayout', () => {
  afterEach(() => {
    clearNotices();
  });

  test('puts the content in the main landmark', async () => {
    await render(
      <PageLayout>
        <h1>로그인하는 중입니다</h1>
      </PageLayout>,
    );

    const main = page.getByRole('main');
    await expect.element(main).toHaveAttribute('id', MAIN_CONTENT_ID);
    await expect.element(main.getByRole('heading', { name: '로그인하는 중입니다' })).toBeInTheDocument();
  });

  test('adds a skip link to the main content only when there is a header', async () => {
    const screen = await render(
      <PageLayout>
        <p>본문</p>
      </PageLayout>,
    );
    expect(screen.container.querySelector(`a[href="#${MAIN_CONTENT_ID}"]`)).toBeNull();

    screen.rerender(
      <PageLayout header={<header>상단</header>}>
        <p>본문</p>
      </PageLayout>,
    );
    await expect.element(page.getByRole('link', { name: '본문으로 건너뛰기' })).toHaveAttribute('href', `#${MAIN_CONTENT_ID}`);
  });

  test('declares the theme variables and paints the page canvas while mounted', async () => {
    const screen = await render(
      <PageLayout>
        <p>본문</p>
      </PageLayout>,
    );

    const root = screen.container.querySelector<HTMLElement>('[data-underview-root]');
    expect(root).not.toBeNull();
    expect(getComputedStyle(root!).getPropertyValue('--underview-color-canvas').trim().toUpperCase()).toBe(
      lightTheme.color.canvas,
    );
    expect(getComputedStyle(document.body).backgroundColor).toBe(getComputedStyle(root!).backgroundColor);

    screen.unmount();

    expect(getComputedStyle(document.body).backgroundColor).not.toBe('rgb(237, 240, 236)');
  });

  test('index.html paints the light canvas before the app loads, in the theme color', () => {
    const earlyCanvasRule = new RegExp(`html\\[${EARLY_CANVAS_ATTRIBUTE}\\][^{]*\\{[^}]*background-color:\\s*(#[0-9A-Fa-f]{6})`);
    const match = indexHTML.match(earlyCanvasRule);

    expect(match?.[1]?.toUpperCase()).toBe(lightTheme.color.canvas);
    expect(indexHTML).toContain(`setAttribute('${EARLY_CANVAS_ATTRIBUTE}'`);
  });

  test('takes over the canvas from index.html once mounted', async () => {
    document.documentElement.setAttribute(EARLY_CANVAS_ATTRIBUTE, '');

    await render(
      <PageLayout>
        <p>본문</p>
      </PageLayout>,
    );

    expect(document.documentElement.hasAttribute(EARLY_CANVAS_ATTRIBUTE)).toBe(false);
    expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(237, 240, 236)');
  });

  test('loads the self-hosted IBM Plex Sans KR for Hangul', async () => {
    await render(
      <PageLayout>
        <p>로그인하는 중입니다</p>
      </PageLayout>,
    );

    const faces = await document.fonts.load('500 16px "IBM Plex Sans KR"', '로그인');
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((face) => face.family.replace(/["']/g, '') === 'IBM Plex Sans KR')).toBe(true);
  });

  test('shows notices raised with showNotice', async () => {
    showNotice({ title: '세션이 만료되었습니다', description: '다시 로그인해주세요.' });

    await render(
      <PageLayout>
        <p>본문</p>
      </PageLayout>,
    );

    await expect.element(page.getByRole('alert')).toHaveTextContent('세션이 만료되었습니다');
  });
});
