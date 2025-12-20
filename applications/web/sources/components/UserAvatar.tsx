import * as Avatar from '@radix-ui/react-avatar';
import type { OAuthUser } from '@audio-underview/sign-provider';
import './UserAvatar.scss';

type AvatarSize = 'default' | 'large';

interface UserAvatarProperties {
  user: OAuthUser | null;
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
