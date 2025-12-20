import styled from '@emotion/styled';
import * as Avatar from '@radix-ui/react-avatar';
import type { OAuthUser } from '@audio-underview/sign-provider';

type AvatarSize = 'default' | 'large';

interface UserAvatarProperties {
  user: OAuthUser | null;
  size?: AvatarSize;
}

const AvatarRoot = styled(Avatar.Root)<{ size: AvatarSize }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  overflow: hidden;
  user-select: none;
  width: ${({ size }) => (size === 'large' ? '80px' : '36px')};
  height: ${({ size }) => (size === 'large' ? '80px' : '36px')};
  border-radius: 50%;
  background-color: var(--accent-primary);
  flex-shrink: 0;
`;

const AvatarImage = styled(Avatar.Image)`
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
`;

const AvatarFallback = styled(Avatar.Fallback)<{ size: AvatarSize }>`
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--accent-primary);
  color: var(--text-primary);
  font-size: ${({ size }) => (size === 'large' ? '2rem' : '1rem')};
  font-weight: 500;
`;

export function UserAvatar({ user, size = 'default' }: UserAvatarProperties) {
  return (
    <AvatarRoot size={size}>
      <AvatarImage src={user?.picture} alt={user?.name ?? 'User avatar'} />
      <AvatarFallback size={size}>
        {user?.name?.charAt(0).toUpperCase()}
      </AvatarFallback>
    </AvatarRoot>
  );
}
