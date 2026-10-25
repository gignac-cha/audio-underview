/**
 * The closing line of the page: what this audio is, who made it, and a way to
 * pass it on.
 *
 * The AI disclosure is not a legal footnote bolted on — it is the sentence that
 * protects the person who shared the link (design doc §8). No call to action and
 * no outbound link: attribution here is a wordmark, nothing more.
 */

import styled from '@emotion/styled';
import { SITE_NAME } from '../constants.ts';
import { CopyLinkButton } from './CopyLinkButton.tsx';

const Footer = styled.footer`
  display: grid;
  gap: 0.75rem;
  justify-items: start;
  padding-top: 0.5rem;
  border-top: 1px solid ${(props) => props.theme.colours.border};
`;

const Disclosure = styled.p`
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: ${(props) => props.theme.colours.textSecondary};
`;

const Wordmark = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: ${(props) => props.theme.colours.textSecondary};
`;

const Mark = styled.img`
  width: 1rem;
  height: 1rem;
  border-radius: 4px;
  opacity: 0.8;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: 100%;
  flex-wrap: wrap;
`;

export interface ShareFooterProps {
  /** Passed to the platform share sheet when one exists. */
  title?: string;
}

export function ShareFooter({ title }: ShareFooterProps) {
  return (
    <Footer>
      <Disclosure>이 뉴스캐스트는 AI가 기사를 요약해 생성한 오디오입니다.</Disclosure>
      <Row>
        <Wordmark>
          <Mark src="/icon-192.png" alt="" width={16} height={16} />
          {SITE_NAME}
        </Wordmark>
        <CopyLinkButton title={title} />
      </Row>
    </Footer>
  );
}
