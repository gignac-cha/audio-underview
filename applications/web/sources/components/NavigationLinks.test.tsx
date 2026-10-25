import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router';
import { NavigationLinks } from './NavigationLinks.tsx';
import { page } from 'vitest/browser';

describe('NavigationLinks', () => {
  test('renders Home link', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByText('Home')).toBeInTheDocument();
  });

  test('renders Crawlers link', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByText('Crawlers')).toBeInTheDocument();
  });

  test('Home link has correct href', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
  });

  test('Crawlers link has correct href', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByRole('link', { name: 'Crawlers' })).toHaveAttribute('href', '/crawlers');
  });

  test('renders Newscasts link with the newscasts href', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByRole('link', { name: 'Newscasts' })).toHaveAttribute('href', '/newscasts');
  });

  test('renders Settings link with the settings href', async () => {
    await render(
      <MemoryRouter>
        <NavigationLinks />
      </MemoryRouter>,
    );

    await expect.element(page.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });
});
