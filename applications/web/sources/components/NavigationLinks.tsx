import styled from '@emotion/styled';
import { NavLink } from 'react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHouse, faSpider } from '@fortawesome/free-solid-svg-icons';

const Container = styled.nav`
  display: flex;
  align-items: center;
  gap: 0.25rem;

  a {
    border-bottom: none;

    &:hover {
      border-bottom: none;
    }
  }
`;

const Link = styled(NavLink)`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  &.active {
    color: var(--text-primary);
    background: var(--accent-muted);
  }

  span {
    @media (max-width: 639px) {
      display: none;
    }
  }
`;

export function NavigationLinks() {
  return (
    <Container>
      <Link to="/home" end>
        <FontAwesomeIcon icon={faHouse} />
        <span>Home</span>
      </Link>
      <Link to="/crawlers">
        <FontAwesomeIcon icon={faSpider} />
        <span>Crawlers</span>
      </Link>
    </Container>
  );
}
