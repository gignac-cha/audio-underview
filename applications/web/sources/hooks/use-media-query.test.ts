import { renderHook } from 'vitest-browser-react';
import { useMediaQuery } from './use-media-query.ts';

describe('useMediaQuery', () => {
  test('returns true for matching query', async () => {
    // In headless Chromium, viewport is typically > 0px
    const { result } = await renderHook(() => useMediaQuery('(min-width: 1px)'));
    expect(result.current).toBe(true);
  });

  test('returns false for non-matching query', async () => {
    const { result } = await renderHook(() => useMediaQuery('(min-width: 99999px)'));
    expect(result.current).toBe(false);
  });

  test('returns correct value for zero-width query', async () => {
    const { result } = await renderHook(() => useMediaQuery('(min-width: 0px)'));
    expect(result.current).toBe(true);
  });
});
