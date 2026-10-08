import styled from '@emotion/styled';
import { color, layout, media, size, space, textStyle } from '../tokens.ts';
import { visuallyHidden } from '../styles.ts';
import { Button } from './Button.tsx';
import { ProfileImage } from './ProfileImage.tsx';

export interface TopBarAccountProps {
  name: string;
  pictureURL?: string;
  /** Sign-out button label, for example `로그아웃`. */
  signOutLabel: string;
  onSignOut: () => void;
}

const Account = styled.div`
  display: flex;
  align-items: center;
  gap: ${space[2]};
  min-width: 0;

  ${media.medium} {
    gap: ${space[3]};
  }
`;

const Name = styled.span`
  ${visuallyHidden};

  ${media.medium} {
    position: static;
    width: auto;
    height: auto;
    margin: 0;
    overflow: hidden;
    clip: auto;
    clip-path: none;
    max-width: ${layout.accountNameMaxWidth};
    ${textStyle.label};
    color: ${color.ink};
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

/**
 * The quiet button keeps its 44px box but mirrors the service name link at the
 * other end of the bar: the same inline padding, pulled out by that padding
 * (and the button's border), so its label ends on the page gutter just as the
 * service name starts on it. With this padding the box and its focus ring
 * still fit inside the 16px gutter at 360px.
 */
const SignOutButton = styled(Button)`
  padding-inline: ${space[2]};
  margin-inline-end: calc(-1 * (${space[2]} + ${size.borderWidth}));
`;

/**
 * The account area for `TopBar`'s trailing slot: profile picture (or the
 * first character of the name), the name, and a sign-out button. Below 768px
 * the name is hidden visually but still read by screen readers.
 */
export function TopBarAccount({ name, pictureURL, signOutLabel, onSignOut }: TopBarAccountProps) {
  return (
    <Account>
      <ProfileImage name={name} pictureURL={pictureURL} size="small" />
      <Name>{name}</Name>
      <SignOutButton variant="quiet" onClick={onSignOut}>
        {signOutLabel}
      </SignOutButton>
    </Account>
  );
}
