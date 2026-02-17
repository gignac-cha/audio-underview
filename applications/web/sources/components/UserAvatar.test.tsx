import { describe, expect } from 'vitest';
import { test } from '../tests/extensions.ts';
import { render } from 'vitest-browser-react';
import { http, HttpResponse } from 'msw';
import { UserAvatar } from './UserAvatar.tsx';
import type { OAuthUser } from '@audio-underview/sign-provider';

const mockUser: OAuthUser = {
  id: 'user-123',
  email: 'test@example.com',
  name: 'Test User',
  picture: 'https://example.com/avatar.jpg',
  provider: 'google',
};

describe('UserAvatar', () => {
  test('renders fallback initial when image is unavailable', async () => {
    const userWithoutPicture: OAuthUser = { ...mockUser, picture: undefined };
    const screen = await render(<UserAvatar user={userWithoutPicture} />);
    await expect.element(screen.getByText('T')).toBeInTheDocument();
  });

  test('shows fallback when image fails to load', async ({ worker }) => {
    worker.use(
      http.get('https://example.com/avatar.jpg', () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const screen = await render(<UserAvatar user={mockUser} />);
    await expect.element(screen.getByText('T')).toBeInTheDocument();
  });

  test('renders with null user without crashing', async () => {
    const screen = await render(<UserAvatar user={null} />);
    expect(screen.container.children.length).toBeGreaterThan(0);
    expect(screen.container.textContent).toBe('');
  });

  test('renders with large size', async () => {
    const userWithoutPicture: OAuthUser = { ...mockUser, picture: undefined };
    const screen = await render(<UserAvatar user={userWithoutPicture} size="large" />);
    await expect.element(screen.getByText('T')).toBeInTheDocument();
  });
});
