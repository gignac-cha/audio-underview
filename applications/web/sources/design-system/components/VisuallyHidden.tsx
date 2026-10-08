import styled from '@emotion/styled';
import { visuallyHidden } from '../styles.ts';

/** Text that screen readers announce but the screen does not show. */
export const VisuallyHidden = styled.span`
  ${visuallyHidden}
`;
