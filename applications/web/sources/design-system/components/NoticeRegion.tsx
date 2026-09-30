import { useEffect, useRef, useState, type FocusEvent } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { faCircleExclamation, faCircleInfo, faXmark } from '@fortawesome/free-solid-svg-icons';
import {
  color,
  duration,
  easing,
  layer,
  layout,
  media,
  noticeVisibleMilliseconds,
  radius,
  shadow,
  size,
  space,
  textStyle,
} from '../tokens.ts';
import { focusRing } from '../styles.ts';
import { dismissNotice, useNotices, type Notice } from '../notice-store.ts';
import { Icon } from './Icon.tsx';

const CLOSE_LABEL = '알림 닫기';

const arrive = keyframes`
  from {
    opacity: 0;
    transform: translateY(${space[2]});
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const Stack = styled.section`
  position: fixed;
  z-index: ${layer.notice};
  inset-inline: ${layout.gutter.small};
  inset-block-end: ${space[4]};
  display: flex;
  flex-direction: column;
  gap: ${space[3]};
  margin: 0;
  padding: 0;
  pointer-events: none;

  ${media.medium} {
    inset-inline-start: auto;
    inset-inline-end: ${layout.gutter.medium};
    inset-block-end: ${space[6]};
    width: min(${layout.noticeMaxWidth}, calc(100% - 2 * ${layout.gutter.medium}));
  }
`;

const Item = styled.div`
  pointer-events: auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  column-gap: ${space[3]};
  padding: ${space[3]} ${space[2]} ${space[3]} ${space[4]};
  background-color: ${color.surface};
  border: ${size.borderWidth} solid ${color.line};
  border-radius: ${radius.container};
  box-shadow: ${shadow.floating};
  color: ${color.ink};
  animation: ${arrive} ${duration.moderate} ${easing.standard};

  ${media.reducedMotion} {
    animation: none;
  }

  ${media.forcedColors} {
    border-color: CanvasText;
  }
`;

const ToneMark = styled.span`
  display: inline-flex;
  padding-block-start: ${space[3]};

  &[data-tone='error'] {
    color: ${color.danger};
  }

  &[data-tone='information'] {
    color: ${color.accent};
  }
`;

const Message = styled.div`
  min-width: 0;
  padding-block: ${space[3]};
`;

const Title = styled.p`
  margin: 0;
  ${textStyle.label};
  font-weight: ${textStyle.heading3.fontWeight};
  color: ${color.ink};
`;

const Description = styled.p`
  margin: ${space[1]} 0 0;
  ${textStyle.small};
  color: ${color.inkSecondary};
`;

const CloseButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${size.touchTarget};
  height: ${size.touchTarget};
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: ${radius.control};
  background-color: transparent;
  color: ${color.inkSecondary};
  cursor: pointer;
  transition:
    background-color ${duration.quick} ${easing.standard},
    color ${duration.quick} ${easing.standard};

  ${focusRing}

  ${media.hover} {
    &:hover {
      background-color: ${color.surfaceSunken};
      color: ${color.ink};
    }
  }

  &:active {
    background-color: ${color.surfacePressed};
  }
`;

function NoticeItem({ notice }: { notice: Notice }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingMilliseconds = useRef(noticeVisibleMilliseconds);

  useEffect(() => {
    if (hovered || focused) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismissNotice(notice.id), remainingMilliseconds.current);
    return () => {
      window.clearTimeout(timer);
      remainingMilliseconds.current = Math.max(0, remainingMilliseconds.current - (Date.now() - startedAt));
    };
  }, [hovered, focused, notice.id]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocused(false);
    }
  };

  return (
    <Item
      role="alert"
      data-tone={notice.tone}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      <ToneMark data-tone={notice.tone}>
        <Icon icon={notice.tone === 'error' ? faCircleExclamation : faCircleInfo} />
      </ToneMark>
      <Message>
        <Title>{notice.title}</Title>
        {notice.description !== undefined && notice.description !== '' && (
          <Description>{notice.description}</Description>
        )}
      </Message>
      <CloseButton type="button" aria-label={CLOSE_LABEL} onClick={() => dismissNotice(notice.id)}>
        <Icon icon={faXmark} />
      </CloseButton>
    </Item>
  );
}

/**
 * Shows notices raised with `showNotice()`. `PageLayout` renders this, so
 * screens do not render it themselves. Each notice is an `alert`, closes
 * itself after a while (paused while hovered or focused), and has a close
 * button.
 */
export function NoticeRegion() {
  const notices = useNotices();

  if (notices.length === 0) {
    return null;
  }

  return (
    <Stack aria-label="알림">
      {notices.map((notice) => (
        <NoticeItem key={notice.id} notice={notice} />
      ))}
    </Stack>
  );
}
