import type { ComponentPropsWithRef, ReactNode } from 'react';
import styled from '@emotion/styled';
import { color, duration, easing, media, radius, size, space, textStyle } from '../tokens.ts';
import { focusRing } from '../styles.ts';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonSize = 'regular' | 'large';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** `primary` is the main action on a screen, `secondary` an outlined alternative, `quiet` a low-emphasis action. */
  variant?: ButtonVariant;
  /** `regular` is 44px tall, `large` is 56px tall. */
  size?: ButtonSize;
  /**
   * An icon or logo shown before the label. It is hidden from screen readers.
   * A `ProviderLogoChip` in a large button sits as far from the start edge as
   * from the top and bottom.
   */
  leading?: ReactNode;
  /** Fills the container width and aligns the content to the start edge, so stacked buttons line up. */
  fullWidth?: boolean;
}

const StyledButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: ${space[3]};
  min-height: ${size.touchTarget};
  min-width: ${size.touchTarget};
  padding: 0 ${space[4]};
  margin: 0;
  border: ${size.borderWidth} solid transparent;
  border-radius: ${radius.control};
  ${textStyle.label};
  text-align: start;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color ${duration.quick} ${easing.standard},
    border-color ${duration.quick} ${easing.standard},
    color ${duration.quick} ${easing.standard};

  ${focusRing}

  &[data-size='large'] {
    min-height: ${size.controlLarge};
    padding: 0 ${space[5]};
    gap: ${space[4]};
    font-size: ${textStyle.lead.fontSize};
  }

  /* The 40px logo chip in the 56px button: the same 8px from the outer start
     edge as from the top and bottom (the 1px border counts toward it), so the
     chip reads as a slot set into the button. */
  &[data-size='large']:has(> [data-button-leading] > [data-logo-chip]) {
    padding-inline-start: calc(${space[2]} - ${size.borderWidth});
  }

  &[data-full-width='true'] {
    display: flex;
    width: 100%;
    justify-content: flex-start;
  }

  /* Hover darkens the fill a clear step and underlines the label, so the
     hovered button stands apart from an identical one next to it. */
  &[data-variant='primary'] {
    background-color: ${color.accent};
    color: ${color.onAccent};

    ${media.hover} {
      &:hover:not(:disabled) {
        background-color: ${color.accentHover};
      }

      &:hover:not(:disabled) > [data-button-label] {
        text-decoration-line: underline;
      }
    }

    &:active:not(:disabled) {
      background-color: ${color.accentPressed};
    }
  }

  &[data-variant='secondary'] {
    background-color: ${color.surface};
    border-color: ${color.lineStrong};
    color: ${color.ink};

    ${media.hover} {
      &:hover:not(:disabled) {
        background-color: ${color.surfaceHover};
        border-color: ${color.ink};
      }
    }

    &:active:not(:disabled) {
      background-color: ${color.surfacePressed};
    }
  }

  &[data-variant='quiet'] {
    background-color: transparent;
    color: ${color.inkSecondary};

    ${media.hover} {
      &:hover:not(:disabled) {
        background-color: ${color.surfaceSunken};
        color: ${color.ink};
      }
    }

    &:active:not(:disabled) {
      background-color: ${color.surfacePressed};
      color: ${color.ink};
    }
  }

  &:disabled {
    cursor: not-allowed;
    background-color: ${color.surfaceSunken};
    border-color: transparent;
    color: ${color.inkMuted};
  }

  ${media.forcedColors} {
    border-color: ButtonText;
  }
`;

const Leading = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
`;

const Label = styled.span`
  min-width: 0;
  text-decoration-thickness: ${size.borderWidth};
  text-underline-offset: 0.25em;
`;

export function Button({
  variant = 'primary',
  size: buttonSize = 'regular',
  leading,
  fullWidth = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <StyledButton
      {...rest}
      type={type}
      data-variant={variant}
      data-size={buttonSize}
      data-full-width={fullWidth ? 'true' : undefined}
    >
      {leading !== undefined && (
        <Leading aria-hidden="true" data-button-leading="">
          {leading}
        </Leading>
      )}
      <Label data-button-label="">{children}</Label>
    </StyledButton>
  );
}
