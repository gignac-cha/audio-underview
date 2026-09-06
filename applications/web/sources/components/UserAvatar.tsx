import type { AuthenticatedUser } from '@audio-underview/schemas';
import { useState } from 'react';
import styles from './Header.module.css';

const initialFromName = (name: string): string => {
  const trimmed = name.trim();
  return trimmed.length === 0 ? '?' : trimmed.charAt(0).toUpperCase();
};

/** 사용자 아바타 — picture 우선, 실패/부재 시 이름 이니셜 폴백. */
export const UserAvatar = ({ user, size = 30 }: { user: AuthenticatedUser; size?: number }) => {
  const [failed, setFailed] = useState(false);
  const dimension = `${String(size)}px`;

  if (user.picture !== undefined && !failed) {
    return (
      <img
        className={styles.avatar}
        style={{ width: dimension, height: dimension }}
        src={user.picture}
        alt={user.name}
        onError={() => {
          setFailed(true);
        }}
      />
    );
  }

  return (
    <span
      className={styles.avatarFallback}
      style={{ width: dimension, height: dimension }}
      aria-label={user.name}
      title={user.name}
    >
      {initialFromName(user.name)}
    </span>
  );
};
