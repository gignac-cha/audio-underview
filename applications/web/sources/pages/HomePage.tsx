import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHeadphones, faSignOutAlt } from '@fortawesome/free-solid-svg-icons';
import { useSign } from '@audio-underview/sign-provider';
import { UserAvatar } from '../components/UserAvatar.tsx';
import './HomePage.scss';

export function HomePage() {
  const { user, logout } = useSign();

  return (
    <div className="home-page">
      <header className="home-header">
        <div className="logo">
          <FontAwesomeIcon icon={faHeadphones} />
          <span>Audio Underview</span>
        </div>

        <div className="user-section">
          <UserAvatar user={user} />

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
            <UserAvatar user={user} size="large" />

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
