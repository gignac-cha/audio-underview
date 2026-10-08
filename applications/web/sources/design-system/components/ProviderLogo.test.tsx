import { render } from 'vitest-browser-react';
import { oauthProviderID } from '@audio-underview/sign-provider';
import { ProviderLogo } from './ProviderLogo.tsx';

type RGBA = { red: number; green: number; blue: number; alpha: number };

/**
 * SHA-256 of Google's official sign-in asset (`signin-assets.zip`,
 * `Android + Web/PNG @4x/Light/Theme=Light, Show text=No, Shape=Square,
 * Platform=Android+Web@4x.png`).
 */
const GOOGLE_ASSET_SHA256 = '2bc2ae8e4c67de66d74bf1deed12cd8f22981270266a487576b671b0b4df361c';

/**
 * Points in the 160 × 160 asset and the color there: four parts of the
 * gradient "G", its white tile, and the tile's grey outline. A single-color
 * or recolored mark could not match all of them.
 */
const GOOGLE_SAMPLES = [
  { part: 'blue bar', x: 100, y: 80, color: { red: 50, green: 135, blue: 255 } },
  { part: 'green bottom', x: 80, y: 115, color: { red: 15, green: 188, blue: 96 } },
  { part: 'yellow left', x: 45, y: 80, color: { red: 255, green: 210, blue: 16 } },
  { part: 'red top', x: 100, y: 50, color: { red: 255, green: 72, blue: 73 } },
  { part: 'white tile', x: 20, y: 20, color: { red: 255, green: 255, blue: 255 } },
  { part: 'grey outline', x: 1, y: 80, color: { red: 116, green: 119, blue: 117 } },
] as const;

const COLOR_TOLERANCE = 8;

/** Draws the image at its natural size onto a canvas and returns a reader for its pixels. */
async function sampleImage(image: HTMLImageElement): Promise<(x: number, y: number) => RGBA> {
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) {
    throw new Error('A 2D canvas context is not available');
  }
  context.drawImage(image, 0, 0);

  return (x, y) => {
    const [red, green, blue, alpha] = context.getImageData(x, y, 1, 1).data;
    return { red, green, blue, alpha };
  };
}

async function sha256(url: string): Promise<string> {
  const response = await fetch(url);
  const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

  test("draws Google's official PNG from the bundle, byte for byte, never from a remote URL", async () => {
    const screen = await render(<ProviderLogo provider="google" />);

    const image = screen.container.querySelector('img');
    expect(image).not.toBeNull();
    const source = image?.getAttribute('src') ?? '';
    expect(source).not.toMatch(/^https?:/);
    expect(source).toMatch(/google\.png/);
    expect(image?.getAttribute('alt')).toBe('');
    expect(await sha256((image as HTMLImageElement).src)).toBe(GOOGLE_ASSET_SHA256);
  });

  test('scales the Google image to the icon sizes, the same 20px and 24px as the other marks', async () => {
    const screen = await render(
      <div>
        <span data-testid="regular">
          <ProviderLogo provider="google" />
        </span>
        <span data-testid="large">
          <ProviderLogo provider="google" size="large" />
        </span>
        <span data-testid="github">
          <ProviderLogo provider="github" />
        </span>
      </div>,
    );

    const regular = screen.container.querySelector('[data-testid="regular"] img')?.getBoundingClientRect();
    const large = screen.container.querySelector('[data-testid="large"] img')?.getBoundingClientRect();
    const github = screen.container.querySelector('[data-testid="github"] [aria-hidden="true"]')?.getBoundingClientRect();
    expect([regular?.width, regular?.height]).toEqual([20, 20]);
    expect([large?.width, large?.height]).toEqual([24, 24]);
    expect([github?.width, github?.height]).toEqual([20, 20]);
  });

  test('keeps the Google image in its own colors, not the single text color', async () => {
    const screen = await render(
      <span style={{ color: 'rgb(255, 0, 255)' }}>
        <ProviderLogo provider="google" size="large" />
      </span>,
    );

    const image = screen.container.querySelector('img') as HTMLImageElement;
    const style = getComputedStyle(image);
    expect(style.filter).toBe('none');
    expect(style.maskImage).toBe('none');
    expect(style.mixBlendMode).toBe('normal');
    expect(style.opacity).toBe('1');

    const pixelAt = await sampleImage(image);
    expect([image.naturalWidth, image.naturalHeight]).toEqual([160, 160]);
    for (const { part, x, y, color } of GOOGLE_SAMPLES) {
      const pixel = pixelAt(x, y);
      expect(pixel.alpha, part).toBe(255);
      expect(Math.abs(pixel.red - color.red), `${part} red`).toBeLessThanOrEqual(COLOR_TOLERANCE);
      expect(Math.abs(pixel.green - color.green), `${part} green`).toBeLessThanOrEqual(COLOR_TOLERANCE);
      expect(Math.abs(pixel.blue - color.blue), `${part} blue`).toBeLessThanOrEqual(COLOR_TOLERANCE);
    }
    // The corner outside the rounded tile is transparent.
    expect(pixelAt(0, 0).alpha).toBe(0);
  });
});
