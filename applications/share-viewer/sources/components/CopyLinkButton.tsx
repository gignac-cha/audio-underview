/**
 * "링크 복사" — a plain utility so a reader can pass the newscast on.
 *
 * Deliberately unbranded and CTA-free (design doc §1 비목표): re-sharing the
 * link the reader already has is not a conversion funnel. Where the platform
 * offers a real share sheet it is used, because on mobile that is what "share"
 * means; everywhere else the URL goes to the clipboard.
 */

import { useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';

/** How long the confirmation replaces the label before it reverts. */
const CONFIRMATION_MILLISECONDS = 2000;

const Button = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4375rem 0.875rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
  color: ${(props) => props.theme.colours.textSecondary};
  background: ${(props) => props.theme.colours.surface};
  border: 1px solid ${(props) => props.theme.colours.border};

  &:hover {
    color: ${(props) => props.theme.colours.textPrimary};
  }
`;

type CopyState = 'idle' | 'copied' | 'failed';

const LABELS: Record<CopyState, string> = {
  idle: '링크 복사',
  copied: '복사됨',
  failed: '복사할 수 없습니다',
};

export interface CopyLinkButtonProps {
  /** The address to hand on. Defaults to the page the reader is looking at. */
  url?: string;
  /** Title offered to the platform share sheet, when there is one. */
  title?: string;
}

export function CopyLinkButton({ url, title }: CopyLinkButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current !== null) {
        clearTimeout(resetTimeoutRef.current);
      }
    },
    [],
  );

  const announce = (next: CopyState) => {
    setState(next);
    if (resetTimeoutRef.current !== null) {
      clearTimeout(resetTimeoutRef.current);
    }
    resetTimeoutRef.current = setTimeout(() => setState('idle'), CONFIRMATION_MILLISECONDS);
  };

  const handleClick = async () => {
    const target = url ?? window.location.href;

    // The share sheet is its own confirmation, so a successful one says nothing.
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(title === undefined ? { url: target } : { title, url: target });
        return;
      } catch {
        // Dismissed or unsupported for this payload — fall through to the clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(target);
      announce('copied');
    } catch {
      announce('failed');
    }
  };

  return (
    <Button type="button" onClick={() => void handleClick()} aria-live="polite">
      {LABELS[state]}
    </Button>
  );
}
