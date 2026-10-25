/**
 * Metadata is opt-in per field, so the card's job is as much about what it does
 * NOT render as what it does — an empty card, or a row labelled "비공개", would
 * leak the shape of what the sharer kept private.
 *
 * Since the credits were demoted to a fold-away block (design doc §8), the card
 * also no longer owns `sharedBy`: that moved to the byline, and a share that
 * published nothing else must not leave a lone "제작 정보" toggle behind.
 */

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithTheme } from '../tests/render-with-theme.tsx';
import { ShareMetadataCard } from './ShareMetadataCard.tsx';
import { SAMPLE_SHARE_VIEW } from '../fixtures/sample-share-view.ts';

describe('ShareMetadataCard', () => {
  it('renders nothing at all when every flag is off', () => {
    const { container } = renderWithTheme(<ShareMetadataCard metadata={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when an opted-in profile carries no values', () => {
    const { container } = renderWithTheme(<ShareMetadataCard metadata={{ sharedBy: {} }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the sharer is the only published field', () => {
    // The byline shows them; there would be no credits behind the toggle.
    const { container } = renderWithTheme(
      <ShareMetadataCard metadata={{ sharedBy: { displayName: '차진혁' } }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders every opted-in field behind a collapsed summary', () => {
    renderWithTheme(<ShareMetadataCard metadata={SAMPLE_SHARE_VIEW.metadata} />);

    const card = screen.getByLabelText('공개된 정보');
    expect(card).not.toHaveAttribute('open');
    expect(screen.getByText('제작 정보')).toBeInTheDocument();
    expect(screen.queryByText('차진혁 · sharer@example.com')).not.toBeInTheDocument();
    expect(screen.getByText('anthropic · claude-sonnet-5 · high')).toBeInTheDocument();

    const sourceLink = screen.getByRole('link', {
      name: 'Understanding is the new bottleneck',
    });
    expect(sourceLink).toHaveAttribute('href', 'https://example.com/understanding');
    expect(screen.getByRole('link', { name: '토론' })).toHaveAttribute(
      'href',
      'https://news.hada.io/topic?id=1',
    );
  });

  it.each([
    ['javascript:', 'javascript:alert(document.domain)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['relative', '/share/other'],
    ['unreadable', 'not a url'],
  ])('links no %s source URL and shows its title as text', (_, url) => {
    const { container } = renderWithTheme(
      <ShareMetadataCard metadata={{ sources: [{ title: '크롤링한 글', originalUrl: url, discussionUrl: url }] }} />,
    );

    expect(screen.getByText('크롤링한 글')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('토론')).not.toBeInTheDocument();
    expect(container.querySelector('[href]')).toBeNull();
  });

  it('links the http source URL even when its discussion URL is not http(s)', () => {
    renderWithTheme(
      <ShareMetadataCard
        metadata={{ sources: [{ title: '절반만 링크', originalUrl: 'http://example.com/a', discussionUrl: 'javascript:void(0)' }] }}
      />,
    );

    expect(screen.getByRole('link', { name: '절반만 링크' })).toHaveAttribute('href', 'http://example.com/a');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('shows only the fields present, leaving no placeholder for the rest', () => {
    renderWithTheme(
      <ShareMetadataCard metadata={{ createdAt: '2026-08-01T00:00:00.000Z' }} />,
    );

    expect(screen.getByText('생성일')).toBeInTheDocument();
    expect(screen.queryByText('공유자')).not.toBeInTheDocument();
    expect(screen.queryByText('생성 모델')).not.toBeInTheDocument();
    expect(screen.queryByText('출처')).not.toBeInTheDocument();
  });

  it('opens on the summary and stays open', async () => {
    const user = userEvent.setup();
    renderWithTheme(<ShareMetadataCard metadata={SAMPLE_SHARE_VIEW.metadata} />);

    await user.click(screen.getByText('제작 정보'));

    expect(screen.getByLabelText('공개된 정보')).toHaveAttribute('open');
  });
});
