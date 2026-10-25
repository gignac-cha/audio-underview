import { describe, expect, it } from 'vitest';
import { hasVisibleMetadata } from './public-share-view.ts';

describe('hasVisibleMetadata', () => {
  it('is false for the default, fully private share', () => {
    expect(hasVisibleMetadata({})).toBe(false);
  });

  it('is false when an opted-in profile turned out to be empty', () => {
    expect(hasVisibleMetadata({ sharedBy: {} })).toBe(false);
    expect(hasVisibleMetadata({ sharedBy: { displayName: '', email: '' } })).toBe(false);
  });

  it('is false for an empty source list', () => {
    expect(hasVisibleMetadata({ sources: [] })).toBe(false);
  });

  it('is true as soon as one field carries a value', () => {
    expect(hasVisibleMetadata({ sharedBy: { displayName: '차진혁' } })).toBe(true);
    expect(hasVisibleMetadata({ createdAt: '2026-08-01T00:00:00.000Z' })).toBe(true);
    expect(
      hasVisibleMetadata({ model: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
    ).toBe(true);
    expect(
      hasVisibleMetadata({
        sources: [{ title: 't', originalUrl: 'https://example.com' }],
      }),
    ).toBe(true);
  });
});
