/**
 * A collapsible section with the list rail's heading style — used to fold the
 * New newscast panel away so the list owns the vertical space. The content
 * stays MOUNTED while collapsed (hidden via CSS) so the panel's state — typed
 * text, provider/model/effort, a start in progress — survives folding.
 */

import type { ReactNode } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons';

const HeaderButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  margin: 0.25rem 0 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);

  &:hover {
    color: var(--text-primary);
  }
`;

const Chevron = styled.span<{ collapsed: boolean }>`
  display: inline-flex;
  font-size: 0.6875rem;
  transition: transform 0.15s ease;
  transform: rotate(${(props) => (props.collapsed ? '-90deg' : '0deg')});
`;

const Badge = styled.span`
  margin-left: auto;
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: none;
  letter-spacing: normal;
  padding: 0.1875rem 0.5rem;
  border-radius: 6px;
  color: var(--text-primary);
  background: rgba(99, 102, 241, 0.25);
`;

const Content = styled.div<{ collapsed: boolean }>`
  display: ${(props) => (props.collapsed ? 'none' : 'flex')};
  flex-direction: column;
  gap: 1rem;
`;

export interface CollapsibleSectionProps {
  title: string;
  /** Optional chip on the header's right (e.g. "Waiting for your pick" while collapsed). */
  badge?: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Unique id wiring aria-controls → the content region. */
  contentID: string;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  badge,
  collapsed,
  onToggle,
  contentID,
  children,
}: CollapsibleSectionProps) {
  return (
    <>
      <HeaderButton
        type="button"
        aria-expanded={!collapsed}
        aria-controls={contentID}
        onClick={onToggle}
      >
        <Chevron collapsed={collapsed} aria-hidden={true}>
          <FontAwesomeIcon icon={faChevronDown} />
        </Chevron>
        {title}
        {badge !== undefined && <Badge>{badge}</Badge>}
      </HeaderButton>
      <Content id={contentID} collapsed={collapsed}>
        {children}
      </Content>
    </>
  );
}
