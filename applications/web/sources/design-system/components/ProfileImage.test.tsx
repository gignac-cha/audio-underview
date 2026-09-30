import { render } from 'vitest-browser-react';
import { ProfileImage } from './ProfileImage.tsx';

const BROKEN_PICTURE_URL = 'data:image/png;base64,broken';

describe('ProfileImage', () => {
  test('shows the first character of the name when there is no picture', async () => {
    const screen = await render(<ProfileImage name="차진혁" />);

    const frame = screen.container.querySelector('[data-profile-image]');
    expect(frame?.getAttribute('data-profile-image')).toBe('initial');
    expect(frame?.textContent).toBe('차');
    expect(frame?.getAttribute('aria-hidden')).toBe('true');
  });

  test('uppercases a Latin first character', async () => {
    const screen = await render(<ProfileImage name="jin" />);

    expect(screen.container.querySelector('[data-profile-image]')?.textContent).toBe('J');
  });

  test('shows the picture when a URL is given', async () => {
    const screen = await render(<ProfileImage name="차진혁" pictureURL="https://example.com/picture.png" />);

    const picture = screen.container.querySelector('img');
    expect(picture?.getAttribute('src')).toBe('https://example.com/picture.png');
    expect(picture?.getAttribute('alt')).toBe('');
  });

  test('falls back to the first character when the picture fails to load', async () => {
    const screen = await render(<ProfileImage name="차진혁" pictureURL={BROKEN_PICTURE_URL} />);

    await expect.poll(() => screen.container.querySelector('[data-profile-image]')?.getAttribute('data-profile-image')).toBe('initial');
    expect(screen.container.querySelector('img')).toBeNull();
    expect(screen.container.querySelector('[data-profile-image]')?.textContent).toBe('차');
  });
});
