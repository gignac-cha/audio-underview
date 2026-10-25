/**
 * The shared "nothing to show" layout: an invalid link, a load failure, and an
 * unknown route are the same shape — an illustration and a short explanation.
 *
 * The invalid-link copy is deliberately identical whether the token never
 * existed or was revoked; the worker answers 404 for both so that a link cannot
 * be probed for existence.
 *
 * The anchor duo from the favicon appears here desaturated and faint (audit
 * A10): with the "make your own" CTA deliberately gone, the page needed
 * something other than two lines of grey text, and a greyed-out mascot reads as
 * "this is empty" rather than as decoration.
 */

import type { ReactNode } from 'react';
import styled from '@emotion/styled';

const Wrapper = styled.main`
  max-width: 32rem;
  margin: 0 auto;
  padding: 3.5rem 1.25rem 4rem;
  display: grid;
  gap: 0.75rem;
  justify-items: start;
`;

const Illustration = styled.img`
  width: clamp(6rem, 30vw, 9rem);
  height: auto;
  margin-bottom: 0.5rem;
  filter: grayscale(1);
  opacity: 0.28;
`;

const Heading = styled.h1`
  margin: 0;
  font-size: 1.375rem;
  font-weight: 700;
  color: ${(props) => props.theme.colours.textPrimary};
`;

const Body = styled.p`
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.7;
  color: ${(props) => props.theme.colours.textSecondary};
`;

export interface NoticeScreenProps {
  heading: string;
  children: ReactNode;
}

export function NoticeScreen({ heading, children }: NoticeScreenProps) {
  return (
    <Wrapper>
      <Illustration src="/notice-illustration.png" alt="" width={144} height={144} />
      <Heading>{heading}</Heading>
      <Body>{children}</Body>
    </Wrapper>
  );
}
