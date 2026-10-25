/**
 * The one piece of chrome every page shares: brand, an explicit "you are
 * looking at someone's shared link" badge, and the theme control.
 */

import styled from '@emotion/styled';
import { SITE_NAME } from '../constants.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

const Bar = styled.header`
  position: sticky;
  top: 0;
  z-index: 10;
  background: ${(props) => props.theme.colours.background};
  border-bottom: 1px solid ${(props) => props.theme.colours.border};
`;

const Inner = styled.div`
  max-width: 56rem;
  margin: 0 auto;
  padding: 0.75rem 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
`;

const Brand = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  margin-right: auto;
`;

const Logo = styled.img`
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 8px;
`;

const Wordmark = styled.span`
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: ${(props) => props.theme.colours.textPrimary};
`;

const ShareBadge = styled.span`
  padding: 0.1875rem 0.5rem;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  color: ${(props) => props.theme.colours.brandPrimaryStrong};
  background: ${(props) => props.theme.colours.surfaceAlternate};
  border: 1px solid ${(props) => props.theme.colours.border};
`;

export interface ViewerHeaderProps {
  /** Hidden on the landing page, where the badge would be a lie. */
  showShareBadge?: boolean;
}

export function ViewerHeader({ showShareBadge = false }: ViewerHeaderProps) {
  return (
    <Bar>
      <Inner>
        <Brand>
          <Logo src="/icon-192.png" alt="" width={28} height={28} />
          <Wordmark>{SITE_NAME}</Wordmark>
          {showShareBadge && <ShareBadge>공유된 뉴스캐스트</ShareBadge>}
        </Brand>
        <ThemeToggle />
      </Inner>
    </Bar>
  );
}
