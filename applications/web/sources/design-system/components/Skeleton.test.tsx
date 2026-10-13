import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { LoadingPlaceholder, Skeleton } from './Skeleton.tsx';
import { ActivityIndicator } from './ActivityIndicator.tsx';

describe('Skeleton', () => {
  test('announces the loading label once and keeps the shapes silent', async () => {
    const screen = await render(
      <LoadingPlaceholder label="연결된 로그인을 불러오는 중입니다">
        <Skeleton width="long" />
        <Skeleton shape="circle" />
        <Skeleton shape="block" width="full" />
      </LoadingPlaceholder>,
    );

    await expect.element(page.getByRole('status')).toHaveTextContent('연결된 로그인을 불러오는 중입니다');
    expect(screen.container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
  });

  test('gives every shape a visible size', async () => {
    const screen = await render(
      <div style={{ width: '20rem' }}>
        <Skeleton width="medium" textSize="heading2" />
        <Skeleton shape="circle" />
        <Skeleton shape="block" />
      </div>,
    );

    for (const shape of Array.from(screen.container.querySelectorAll('[data-shape]'))) {
      const rectangle = shape.getBoundingClientRect();
      expect(rectangle.width).toBeGreaterThan(0);
      expect(rectangle.height).toBeGreaterThan(0);
    }
  });
});

describe('ActivityIndicator', () => {
  test('is hidden from screen readers so the status text speaks for it', async () => {
    const screen = await render(<ActivityIndicator size="large" />);

    const meter = screen.container.firstElementChild;
    expect(meter?.getAttribute('aria-hidden')).toBe('true');
    expect(meter?.children).toHaveLength(5);
  });

  test('takes its height from the text beside it at the text size', async () => {
    const screen = await render(
      <div style={{ fontSize: '20px' }}>
        <ActivityIndicator size="text" />
      </div>,
    );

    const meter = screen.container.querySelector('[aria-hidden="true"]');
    expect(meter?.getBoundingClientRect().height).toBeCloseTo(16, 0);
  });
});
