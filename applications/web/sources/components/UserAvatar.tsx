import * as Avatar from '@radix-ui/react-avatar';
import type { GoogleUser } from '../schemas/authentication.ts';
import './UserAvatar.scss';

type AvatarSize = 'default' | 'large';

interface UserAvatarProperties {
  user: GoogleUser | null;
  size?: AvatarSize;
}

export function UserAvatar({ user, size = 'default' }: UserAvatarProperties) {
  const className = size === 'large' ? 'avatar-root large' : 'avatar-root';

  return (
    <Avatar.Root className={className}>
      <Avatar.Image
        className="avatar-image"
        src={user?.picture}
        alt={user?.name}
      />
      <Avatar.Fallback className="avatar-fallback">
        {user?.name?.charAt(0).toUpperCase()}
      </Avatar.Fallback>
    </Avatar.Root>
  );
}
