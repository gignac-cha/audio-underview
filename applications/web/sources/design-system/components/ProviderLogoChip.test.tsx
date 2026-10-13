import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { Button } from './Button.tsx';
import { PageLayout } from './PageLayout.tsx';
import { ProviderLogoChip } from './ProviderLogoChip.tsx';
import { lightTheme } from '../tokens.ts';

function toRGB(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`;
}

const WHITE = toRGB(lightTheme.color.logoBackground);
const OUTLINE = toRGB(lightTheme.color.logoOutline);
const DARK_MARK = toRGB(lightTheme.color.onLogoBackground);

const GOOGLE_LABEL = 'Google로 계속하기';
const GITHUB_LABEL = 'GitHub로 계속하기';

/** Google's asset is drawn at @4x: 160 image pixels fill the 40px chip. */
const GOOGLE_ASSET_SCALE = 4;

async function renderProviderButtons() {
  await render(
    <PageLayout>
      <Button variant="primary" size="large" fullWidth leading={<ProviderLogoChip provider="google" />}>
        {GOOGLE_LABEL}
      </Button>
      <Button variant="primary" size="large" fullWidth leading={<ProviderLogoChip provider="github" />}>
        {GITHUB_LABEL}
      </Button>
    </PageLayout>,
  );

  return { google: providerButton(GOOGLE_LABEL), github: providerButton(GITHUB_LABEL) };
}

function providerButton(label: string) {
  const button = page.getByRole('button', { name: label, exact: true }).element() as HTMLButtonElement;
  const chip = button.querySelector<HTMLElement>('[data-logo-chip]');
  if (chip === null) {
    throw new Error(`The logo chip is missing in ${label}`);
  }
  return { button, chip };
}

/** Everything about the Google chip that a button state could change. */
function googleChipLook(chip: HTMLElement) {
  const box = chip.getBoundingClientRect();
  const style = getComputedStyle(chip);
  const leadingStyle = getComputedStyle(chip.parentElement as HTMLElement);
  return {
    source: chip.getAttribute('src'),
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    opacity: style.opacity,
    filter: style.filter,
    mixBlendMode: style.mixBlendMode,
    visibility: style.visibility,
    backgroundColor: style.backgroundColor,
    borderWidth: style.borderTopWidth,
    leadingOpacity: leadingStyle.opacity,
    leadingFilter: leadingStyle.filter,
  };
}

/** The drawn chip's white, outline, and corner. */
function drawnChipLook(chip: HTMLElement) {
  const style = getComputedStyle(chip);
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderTopColor,
    borderWidth: style.borderTopWidth,
    borderStyle: style.borderTopStyle,
    borderRadius: style.borderTopLeftRadius,
  };
}

/** Reads Google's asset at its natural size, to measure its outline. */
async function readGoogleAsset(image: HTMLImageElement) {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('A 2D canvas context is not available');
  }
  context.drawImage(image, 0, 0);
  return (x: number, y: number) => {
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    return { red, green, blue, alpha };
  };
}

describe('ProviderLogoChip', () => {
  test("uses Google's official image as the Google chip, with nothing painted behind it", async () => {
    const { google } = await renderProviderButtons();

    expect(google.chip.tagName).toBe('IMG');
    expect(google.chip.getAttribute('src')).not.toMatch(/^https?:/);
    expect(google.chip.getAttribute('src')).toMatch(/google\.png/);
    expect(google.chip.getAttribute('alt')).toBe('');
    const look = googleChipLook(google.chip);
    expect(look.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(look.borderWidth).toBe('0px');
    expect(look.filter).toBe('none');
  });

  test('is the same 40 × 40 chip, set the same way, in both buttons', async () => {
    const { google, github } = await renderProviderButtons();

    for (const { button, chip } of [google, github]) {
      const buttonBox = button.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      expect([chipBox.width, chipBox.height]).toEqual([40, 40]);
      // Same distance from the start edge as from the top and bottom.
      expect(chipBox.left - buttonBox.left).toBe(8);
      expect(chipBox.top - buttonBox.top).toBe(8);
      expect(buttonBox.bottom - chipBox.bottom).toBe(8);
    }

    // The label starts at the same place in both buttons.
    const googleLabel = google.button.querySelector('[data-button-label]')?.getBoundingClientRect();
    const githubLabel = github.button.querySelector('[data-button-label]')?.getBoundingClientRect();
    expect(githubLabel?.left).toBe(googleLabel?.left);
  });

  test("draws the GitHub chip with the Google image's white, outline, corner, and mark size", async () => {
    const { google, github } = await renderProviderButtons();
    const pixelAt = await readGoogleAsset(google.chip as HTMLImageElement);

    // The outline: grey pixels from the image's left edge along its middle row.
    let outlinePixels = 0;
    while (pixelAt(outlinePixels, 80).red < 200) {
      outlinePixels += 1;
    }
    const outline = pixelAt(1, 80);
    const white = pixelAt(20, 20);

    const look = drawnChipLook(github.chip);
    expect(look.backgroundColor).toBe(`rgb(${white.red}, ${white.green}, ${white.blue})`);
    expect(look.backgroundColor).toBe(WHITE);
    expect(look.borderColor).toBe(`rgb(${outline.red}, ${outline.green}, ${outline.blue})`);
    expect(look.borderColor).toBe(OUTLINE);
    expect(look.borderStyle).toBe('solid');
    expect(look.borderWidth).toBe(`${outlinePixels / GOOGLE_ASSET_SCALE}px`);
    // The image's corner is 16px at @4x (transparent at its very corner pixel).
    expect(pixelAt(0, 0).alpha).toBe(0);
    expect(look.borderRadius).toBe('4px');

    // The mark is as large as the "G" in the image (20px) and centered.
    const chipBox = github.chip.getBoundingClientRect();
    const markBox = github.chip.querySelector('[aria-hidden="true"]')?.getBoundingClientRect();
    expect([markBox?.width, markBox?.height]).toEqual([20, 20]);
    expect((markBox?.left ?? 0) - chipBox.left).toBe(10);
    expect((markBox?.top ?? 0) - chipBox.top).toBe(10);
  });

  test('keeps the Google image as it is while its button is hovered, focused, and pressed', async () => {
    const { google } = await renderProviderButtons();
    const resting = googleChipLook(google.chip);
    const restingFill = getComputedStyle(google.button).backgroundColor;
    expect(resting.opacity).toBe('1');
    expect(resting.filter).toBe('none');
    expect(resting.mixBlendMode).toBe('normal');
    expect(resting.visibility).toBe('visible');

    await userEvent.hover(google.button);
    // The fill eases over a short transition; wait for it to settle on the hover color.
    await expect.poll(() => getComputedStyle(google.button).backgroundColor).not.toBe(restingFill);
    expect(googleChipLook(google.chip)).toEqual(resting);
    await userEvent.unhover(google.button);

    await userEvent.tab();
    expect(document.activeElement).toBe(google.button);
    expect(google.button.matches(':focus-visible')).toBe(true);
    expect(googleChipLook(google.chip)).toEqual(resting);

    await userEvent.keyboard('{Space>}');
    expect(google.button.matches(':active')).toBe(true);
    expect(googleChipLook(google.chip)).toEqual(resting);
    await userEvent.keyboard('{/Space}');
  });

  test('keeps the GitHub chip white with its outline while its button is hovered, focused, and pressed', async () => {
    const { github } = await renderProviderButtons();
    const resting = drawnChipLook(github.chip);
    const restingFill = getComputedStyle(github.button).backgroundColor;
    expect(resting.backgroundColor).toBe(WHITE);
    expect(resting.borderColor).toBe(OUTLINE);

    await userEvent.hover(github.button);
    await expect.poll(() => getComputedStyle(github.button).backgroundColor).not.toBe(restingFill);
    expect(drawnChipLook(github.chip)).toEqual(resting);
    await userEvent.unhover(github.button);

    // The Google button comes first in the tab order.
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(github.button);
    expect(github.button.matches(':focus-visible')).toBe(true);
    expect(drawnChipLook(github.chip)).toEqual(resting);

    await userEvent.keyboard('{Space>}');
    expect(github.button.matches(':active')).toBe(true);
    expect(drawnChipLook(github.chip)).toEqual(resting);
    await userEvent.keyboard('{/Space}');
  });

  test('draws a single-color mark dark on the white chip, not in the button text color', async () => {
    const { github } = await renderProviderButtons();
    const mark = github.chip.querySelector('svg');

    expect(getComputedStyle(github.button).color).toBe('rgb(255, 255, 255)');
    expect(mark?.getAttribute('fill')).toBe('currentColor');
    expect(mark === null ? undefined : getComputedStyle(mark).color).toBe(DARK_MARK);
  });
});
