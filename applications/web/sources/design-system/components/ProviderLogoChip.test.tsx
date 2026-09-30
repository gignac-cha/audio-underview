import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import type { OAuthProviderID } from '@audio-underview/sign-provider';
import { Button } from './Button.tsx';
import { PageLayout } from './PageLayout.tsx';
import { ProviderLogoChip } from './ProviderLogoChip.tsx';
import { lightTheme } from '../tokens.ts';

function toRGB(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

const WHITE = toRGB(lightTheme.color.logoBackground);
const DARK_MARK = toRGB(lightTheme.color.onLogoBackground);

async function renderProviderButton(provider: OAuthProviderID, label: string) {
  await render(
    <PageLayout>
      <Button variant="primary" size="large" fullWidth leading={<ProviderLogoChip provider={provider} />}>
        {label}
      </Button>
    </PageLayout>,
  );

  const button = page.getByRole('button', { name: label, exact: true }).element() as HTMLButtonElement;
  const chip = button.querySelector<HTMLElement>('[data-logo-chip]');
  if (chip === null) {
    throw new Error('The logo chip is missing');
  }
  return { button, chip };
}

describe('ProviderLogoChip', () => {
  test('is white at rest, hovered, focused, and pressed, while the button fill changes', async () => {
    const { button, chip } = await renderProviderButton('google', 'Google로 계속하기');
    const restingFill = getComputedStyle(button).backgroundColor;
    expect(lightTheme.color.logoBackground).toBe('#FFFFFF');
    expect(getComputedStyle(chip).backgroundColor).toBe(WHITE);

    await userEvent.hover(button);
    // The fill eases over a short transition; wait for it to settle on the hover color.
    await expect.poll(() => getComputedStyle(button).backgroundColor).not.toBe(restingFill);
    expect(getComputedStyle(chip).backgroundColor).toBe(WHITE);
    await userEvent.unhover(button);

    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    expect(button.matches(':focus-visible')).toBe(true);
    expect(getComputedStyle(chip).backgroundColor).toBe(WHITE);

    await userEvent.keyboard('{Space>}');
    expect(button.matches(':active')).toBe(true);
    expect(getComputedStyle(chip).backgroundColor).toBe(WHITE);
    await userEvent.keyboard('{/Space}');
  });

  test('holds the mark at a fixed size with fixed padding, set into the button', async () => {
    const { button, chip } = await renderProviderButton('google', 'Google로 계속하기');
    const logo = chip.querySelector('img');
    const buttonBox = button.getBoundingClientRect();
    const chipBox = chip.getBoundingClientRect();
    const logoBox = logo?.getBoundingClientRect();

    expect(chipBox.width).toBe(40);
    expect(chipBox.height).toBe(40);
    expect(logoBox?.width).toBe(24);
    expect(logoBox?.height).toBe(24);
    expect((logoBox?.left ?? 0) - chipBox.left).toBe(8);
    expect((logoBox?.top ?? 0) - chipBox.top).toBe(8);

    // Same distance from the start edge as from the top and bottom.
    expect(chipBox.left - buttonBox.left).toBe(8);
    expect(chipBox.top - buttonBox.top).toBe(8);
    expect(buttonBox.bottom - chipBox.bottom).toBe(8);
  });

  test('draws a single-color mark dark on the white chip, not in the button text color', async () => {
    const { button, chip } = await renderProviderButton('github', 'GitHub로 계속하기');
    const mark = chip.querySelector('svg');

    expect(getComputedStyle(button).color).toBe('rgb(255, 255, 255)');
    expect(mark?.getAttribute('fill')).toBe('currentColor');
    expect(mark === null ? undefined : getComputedStyle(mark).color).toBe(DARK_MARK);
    expect(chip.getBoundingClientRect().width).toBe(40);
  });
});
