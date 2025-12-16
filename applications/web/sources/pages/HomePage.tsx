import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import * as Avatar from '@radix-ui/react-avatar';
import { useAuthentication } from '../contexts/AuthenticationContext.tsx';
import './HomePage.scss';

export function HomePage() {
  const { user, logout } = useAuthentication();

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="logo">
          <FontAwesomeIcon icon={faHeadphones} />
          <span>Audio Underview</span>
        </div>

        <div className="user-section">
          <Avatar.Root className="avatar-root">
            <Avatar.Image
              className="avatar-image"
              src={user?.picture}
              alt={user?.name}
            />
            <Avatar.Fallback className="avatar-fallback">
              {user?.name?.charAt(0).toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>

          <button className="logout-button" onClick={logout}>
            <FontAwesomeIcon icon={faSignOutAlt} />
            <span>Sign Out</span>
          </button>
        </div>
      </header>

      <main className="home-main">
        <div className="welcome-card">
          <h1>Welcome, {user?.name}!</h1>
          <p>You are successfully signed in.</p>

          <div className="user-info">
            <Avatar.Root className="avatar-root large">
              <Avatar.Image
                className="avatar-image"
                src={user?.picture}
                alt={user?.name}
              />
              <Avatar.Fallback className="avatar-fallback">
                {user?.name?.charAt(0).toUpperCase()}
              </Avatar.Fallback>
            </Avatar.Root>

            <div className="user-details">
              <p className="user-name">{user?.name}</p>
              <p className="user-email">{user?.email}</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
