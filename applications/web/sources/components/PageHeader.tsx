import styled from '@emotion/styled';

export const Header = styled.header`
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1.5rem;
  background: rgba(10, 10, 10, 0.9);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-subtle);
`;

export const LogoutButton = styled.button`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  span {
    display: none;

    @media (min-width: 640px) {
      display: inline;
    }
  }
`;

export const UserSection = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
`;
