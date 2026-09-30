import { render } from 'vitest-browser-react';
import { oauthProviderID } from '@audio-underview/sign-provider';
import { ProviderLogo } from './ProviderLogo.tsx';

type RGBA = { red: number; green: number; blue: number; alpha: number };

/**
 * Google's standard colors, and a point inside each part of the "G" in the
 * logo file's 24 × 24 viewBox. The point at the left of the bar is inside the
 * letter's counter, so it must stay empty.
 */
const GOOGLE_PARTS = [
  { part: 'blue bar', x: 17, y: 12, color: { red: 0x42, green: 0x85, blue: 0xf4 } },
  { part: 'green bottom', x: 12, y: 21, color: { red: 0x34, green: 0xa8, blue: 0x53 } },
  { part: 'yellow left', x: 3, y: 12, color: { red: 0xfb, green: 0xbc, blue: 0x05 } },
  { part: 'red top', x: 12, y: 3, color: { red: 0xea, green: 0x43, blue: 0x35 } },
] as const;

const GOOGLE_COUNTER = { x: 8, y: 12 } as const;
const VIEW_BOX_SIZE = 24;
const SAMPLE_SCALE = 10;
const COLOR_TOLERANCE = 6;

/** Draws the rendered logo image onto a canvas and returns a reader for points in viewBox units. */
async function sampleImage(image: HTMLImageElement): Promise<(x: number, y: number) => RGBA> {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_BOX_SIZE * SAMPLE_SCALE;
  canvas.height = VIEW_BOX_SIZE * SAMPLE_SCALE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('A 2D canvas context is not available');
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return (x, y) => {
    const [red, green, blue, alpha] = context.getImageData(x * SAMPLE_SCALE, y * SAMPLE_SCALE, 1, 1).data;
    return { red, green, blue, alpha };
  };
}

describe('ProviderLogo', () => {
  test('draws a logo for every provider ID and hides it from screen readers', async () => {
    const screen = await render(
      <div>
        {oauthProviderID.options.map((provider) => (
          <ProviderLogo key={provider} provider={provider} />
        ))}
      </div>,
    );

    const logos = Array.from(screen.container.querySelectorAll('[aria-hidden="true"]'));
    expect(logos).toHaveLength(oauthProviderID.options.length);
    for (const logo of logos) {
      const rectangle = logo.getBoundingClientRect();
      expect(rectangle.width).toBeGreaterThan(0);
      expect(rectangle.height).toBeGreaterThan(0);
    }
  });

  test('draws single-color marks in the current text color: FontAwesome as inline SVG, Naver from a local file', async () => {
    const screen = await render(
      <div>
        <span data-testid="github">
          <ProviderLogo provider="github" />
        </span>
        <span data-testid="naver">
          <ProviderLogo provider="naver" />
        </span>
      </div>,
    );

    const githubLogo = screen.container.querySelector('[data-testid="github"] svg');
    expect(githubLogo?.getAttribute('fill')).toBe('currentColor');
    const naverLogo = screen.container.querySelector<HTMLElement>('[data-testid="naver"] [aria-hidden="true"]');
    expect(naverLogo?.style.maskImage).toMatch(/^url\(/);
  });

  test('draws the Google "G" in its four standard colors, not in the text color', async () => {
    const screen = await render(
      <span data-testid="google" style={{ color: 'rgb(255, 0, 255)' }}>
        <ProviderLogo provider="google" size="large" />
      </span>,
    );

    const image = screen.container.querySelector<HTMLImageElement>('[data-testid="google"] img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('src')).not.toMatch(/^https?:/);
    expect(image?.getBoundingClientRect().width).toBe(24);

    const pixelAt = await sampleImage(image as HTMLImageElement);
    for (const { part, x, y, color } of GOOGLE_PARTS) {
      const pixel = pixelAt(x, y);
      expect(pixel.alpha, part).toBe(255);
      expect(Math.abs(pixel.red - color.red), `${part} red`).toBeLessThanOrEqual(COLOR_TOLERANCE);
      expect(Math.abs(pixel.green - color.green), `${part} green`).toBeLessThanOrEqual(COLOR_TOLERANCE);
      expect(Math.abs(pixel.blue - color.blue), `${part} blue`).toBeLessThanOrEqual(COLOR_TOLERANCE);
    }
    expect(pixelAt(GOOGLE_COUNTER.x, GOOGLE_COUNTER.y).alpha).toBe(0);
  });
});
