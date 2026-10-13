import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { Button } from './Button.tsx';
import { ProviderLogo } from './ProviderLogo.tsx';

describe('Button', () => {
  test('is a plain button by default so it never submits a form', async () => {
    await render(<Button>다시 시도</Button>);

    await expect.element(page.getByRole('button', { name: '다시 시도' })).toHaveAttribute('type', 'button');
  });

  test('calls onClick when pressed', async () => {
    const onClick = vi.fn();
    await render(<Button onClick={onClick}>로그아웃</Button>);

    await page.getByRole('button', { name: '로그아웃' }).click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('keeps the leading logo out of the accessible name', async () => {
    await render(
      <Button size="large" fullWidth leading={<ProviderLogo provider="google" size="large" />}>
        Google로 계속하기
      </Button>,
    );

    await expect.element(page.getByRole('button', { name: 'Google로 계속하기', exact: true })).toBeInTheDocument();
  });

  test('is at least 44px tall in both sizes', async () => {
    await render(
      <div>
        <Button variant="quiet">로그아웃</Button>
        <Button size="large">Google로 계속하기</Button>
      </div>,
    );

    for (const name of ['로그아웃', 'Google로 계속하기']) {
      const element = page.getByRole('button', { name }).element();
      expect(element.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  });
});
