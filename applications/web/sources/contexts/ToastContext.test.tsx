import { describe, test, expect } from 'vitest';
import { render, renderHook } from 'vitest-browser-react';
import { ToastProvider, useToast } from './ToastContext.tsx';

function ToastTrigger({ type, title, description }: { type: 'toast' | 'error' | 'success'; title: string; description?: string }) {
  const { showToast, showError, showSuccess } = useToast();

  const handleClick = () => {
    if (type === 'error') {
      showError(title, description);
    } else if (type === 'success') {
      showSuccess(title, description);
    } else {
      showToast(title, description);
    }
  };

  return <button onClick={handleClick}>Trigger</button>;
}

describe('useToast', () => {
  test('provides showToast, showError, showSuccess functions', async () => {
    const { result } = await renderHook(() => useToast(), {
      wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider>,
    });
    expect(typeof result.current.showToast).toBe('function');
    expect(typeof result.current.showError).toBe('function');
    expect(typeof result.current.showSuccess).toBe('function');
  });
});

describe('ToastProvider', () => {
  test('renders children', async () => {
    const screen = await render(
      <ToastProvider>
        <div>Test Content</div>
      </ToastProvider>,
    );
    await expect.element(screen.getByText('Test Content')).toBeInTheDocument();
  });

  test('shows toast when showToast is called', async () => {
    const screen = await render(
      <ToastProvider>
        <ToastTrigger type="toast" title="Test Toast" description="Test description" />
      </ToastProvider>,
    );
    await screen.getByText('Trigger').click();
    await expect.element(screen.getByText('Test Toast')).toBeInTheDocument();
    await expect.element(screen.getByText('Test description')).toBeInTheDocument();
  });

  test('shows error toast when showError is called', async () => {
    const screen = await render(
      <ToastProvider>
        <ToastTrigger type="error" title="Error occurred" />
      </ToastProvider>,
    );
    await screen.getByText('Trigger').click();
    await expect.element(screen.getByText('Error occurred')).toBeInTheDocument();
  });

  test('shows success toast when showSuccess is called', async () => {
    const screen = await render(
      <ToastProvider>
        <ToastTrigger type="success" title="Operation complete" />
      </ToastProvider>,
    );
    await screen.getByText('Trigger').click();
    await expect.element(screen.getByText('Operation complete')).toBeInTheDocument();
  });
});
