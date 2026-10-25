import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import { CollapsibleSection } from './CollapsibleSection.tsx';

async function renderSection(collapsed: boolean, onToggle = vi.fn(), badge?: string) {
  await render(
    <CollapsibleSection title="New newscast" badge={badge} collapsed={collapsed} onToggle={onToggle} contentID="create-section">
      <p>form content</p>
    </CollapsibleSection>,
  );
  return onToggle;
}

describe('CollapsibleSection', () => {
  test('shows content and aria-expanded=true when expanded', async () => {
    await renderSection(false);

    await expect.element(page.getByText('form content')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /New newscast/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('keeps content MOUNTED but hidden when collapsed (state survives folding)', async () => {
    await renderSection(true);

    await expect.element(page.getByText('form content')).toBeInTheDocument();
    await expect.element(page.getByText('form content')).not.toBeVisible();
    await expect.element(page.getByRole('button', { name: /New newscast/ })).toHaveAttribute('aria-expanded', 'false');
  });

  test('invokes onToggle from the header button', async () => {
    const onToggle = await renderSection(true);

    await page.getByRole('button', { name: /New newscast/ }).click();

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('renders the badge chip when provided', async () => {
    await renderSection(true, vi.fn(), 'Waiting for your pick');

    await expect.element(page.getByText('Waiting for your pick')).toBeInTheDocument();
  });
});
