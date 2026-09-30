import { useState } from 'react';
import styled from '@emotion/styled';
import { color, fontSize, fontWeight, radius, size } from '../tokens.ts';

export type ProfileImageSize = 'small' | 'large';

export interface ProfileImageProps {
  /** The person's name. Its first character is shown when there is no picture. */
  name: string;
  /** Profile picture URL. When missing or failing to load, the first character of `name` is shown. */
  pictureURL?: string;
  /** `small` is 32px (top bar), `large` is 72px (account section). */
  size?: ProfileImageSize;
}

const DIMENSIONS: Record<ProfileImageSize, { box: string; initial: string }> = {
  small: { box: size.avatarSmall, initial: fontSize.body },
  large: { box: size.avatarLarge, initial: fontSize.heading1 },
};

const Frame = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: ${radius.round};
  background-color: ${color.accentSoft};
  color: ${color.accent};
  font-weight: ${fontWeight.semibold};
  line-height: 1;
  user-select: none;
`;

const Picture = styled.img`
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
`;

function firstCharacter(name: string): string {
  const [first = ''] = Array.from(name.trim());
  return first.toLocaleUpperCase('ko-KR');
}

/**
 * Profile picture, or the first character of the name when there is none.
 * Decorative: always place the name next to it.
 */
export function ProfileImage({ name, pictureURL, size: imageSize = 'small' }: ProfileImageProps) {
  const [failedURL, setFailedURL] = useState<string | undefined>(undefined);
  const dimensions = DIMENSIONS[imageSize];
  const showsPicture = pictureURL !== undefined && pictureURL !== '' && pictureURL !== failedURL;

  return (
    <Frame
      aria-hidden="true"
      data-profile-image={showsPicture ? 'picture' : 'initial'}
      style={{ width: dimensions.box, height: dimensions.box, fontSize: dimensions.initial }}
    >
      {showsPicture ? (
        <Picture src={pictureURL} alt="" referrerPolicy="no-referrer" onError={() => setFailedURL(pictureURL)} />
      ) : (
        firstCharacter(name)
      )}
    </Frame>
  );
}
