import { render } from 'vitest-browser-react';
import { oauthProviderID } from '@audio-underview/sign-provider';
import { ProviderLogo } from './ProviderLogo.tsx';

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

  test('draws FontAwesome marks as inline SVG and the Naver mark from a local file', async () => {
    const screen = await render(
      <div>
        <span data-testid="google">
          <ProviderLogo provider="google" />
        </span>
        <span data-testid="naver">
          <ProviderLogo provider="naver" />
        </span>
      </div>,
    );

    expect(screen.container.querySelector('[data-testid="google"] svg path')).not.toBeNull();
    const naverLogo = screen.container.querySelector<HTMLElement>('[data-testid="naver"] [aria-hidden="true"]');
    expect(naverLogo?.style.maskImage).toMatch(/^url\(/);
  });
});
