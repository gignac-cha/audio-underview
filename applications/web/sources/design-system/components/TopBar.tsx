import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import styled from '@emotion/styled';
import {
  color,
  duration,
  easing,
  fontSize,
  fontWeight,
  layer,
  layout,
  letterSpacing,
  lineHeight,
  media,
  radius,
  size,
  space,
  textStyle,
} from '../tokens.ts';
import { focusRing, linkReset } from '../styles.ts';

export interface TopBarNavigationItem {
  label: string;
  path: string;
}

export interface TopBarProps {
  /** Service name shown at the start; links to `homePath`. */
  serviceName: string;
  homePath: string;
  /** Accessible name of the `nav` landmark. */
  navigationLabel: string;
  navigationItems: readonly TopBarNavigationItem[];
  /** Content at the end of the bar, usually `TopBarAccount`. */
  trailing?: ReactNode;
}

const Header = styled.header`
  position: relative;
  z-index: ${layer.topBar};
  background-color: ${color.canvas};
  border-bottom: ${size.borderWidth} solid ${color.line};

  ${media.medium} {
    position: sticky;
    top: 0;
  }
`;

const Inner = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'brand trailing'
    'navigation navigation';
  align-items: center;
  column-gap: ${space[4]};
  max-width: ${layout.contentMaxWidth};
  margin: 0 auto;
  padding: ${space[2]} ${layout.gutter.small} 0;

  ${media.medium} {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'brand navigation trailing';
    column-gap: ${space[6]};
    padding: ${space[3]} ${layout.gutter.medium};
  }

  ${media.large} {
    padding-inline: ${layout.gutter.large};
  }
`;

const Brand = styled(Link)`
  ${linkReset};
  grid-area: brand;
  justify-self: start;
  display: inline-flex;
  align-items: center;
  min-height: ${size.touchTarget};
  margin-inline-start: calc(-1 * ${space[2]});
  padding-inline: ${space[2]};
  border-radius: ${radius.control};
  font-size: ${fontSize.lead};
  font-weight: ${fontWeight.semibold};
  line-height: ${lineHeight.compact};
  letter-spacing: ${letterSpacing.heading};
  color: ${color.ink};
  white-space: nowrap;

  ${focusRing}

  &:hover {
    color: ${color.accent};
  }
`;

const Navigation = styled.nav`
  grid-area: navigation;
  min-width: 0;
`;

/* Pulled back by the items' inline padding, so the first label starts on the gutter. */
const NavigationList = styled.ul`
  display: flex;
  gap: ${space[1]};
  margin: 0 0 0 calc(-1 * ${space[3]});
  padding: 0;
  list-style: none;
`;

/**
 * Every item is at least 44px wide as well as tall, so a one-character label
 * such as '홈' still gets a full tap target. The label sits at the start of
 * that box, after the same padding as every other item, so the first label
 * starts on the page gutter like the service name; a short label's extra
 * room goes to the end. Items other than the current page use the regular
 * weight and secondary ink, so the current page differs in weight, color,
 * and the underline.
 */
const NavigationLink = styled(NavLink)`
  ${linkReset};
  display: inline-flex;
  align-items: stretch;
  justify-content: flex-start;
  min-height: ${size.touchTarget};
  min-inline-size: ${size.touchTarget};
  padding-inline: ${space[3]};
  border-radius: ${radius.control};
  ${textStyle.label};
  font-weight: ${fontWeight.regular};
  color: ${color.inkSecondary};
  white-space: nowrap;

  ${focusRing}

  ${media.hover} {
    &:hover {
      color: ${color.ink};
      background-color: ${color.surfaceSunken};
    }
  }

  &[aria-current='page'] {
    color: ${color.ink};
    font-weight: ${fontWeight.semibold};
  }

  &[aria-current='page'] > [data-navigation-label]::after {
    background-color: ${color.accent};
  }

  ${media.forcedColors} {
    &[aria-current='page'] > [data-navigation-label]::after {
      background-color: LinkText;
    }
  }
`;

/**
 * The label box runs the item's full height and exactly the label's width.
 * The current-page underline hangs from it onto the header's bottom border,
 * like a tab, and spans the label, so it never reaches past the gutter.
 */
const NavigationLabel = styled.span`
  position: relative;
  display: flex;
  align-items: center;

  &::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    bottom: calc(-1 * ${size.borderWidth});
    height: ${size.currentIndicator};
    border-radius: ${size.currentIndicator} ${size.currentIndicator} 0 0;
    background-color: transparent;
    transition: background-color ${duration.quick} ${easing.standard};

    ${media.medium} {
      bottom: calc(-1 * (${space[3]} + ${size.borderWidth}));
    }
  }
`;

const Trailing = styled.div`
  grid-area: trailing;
  justify-self: end;
  display: flex;
  align-items: center;
  min-width: 0;
`;

/**
 * The top bar: a `header` landmark holding the service name (a link home), a
 * `nav` landmark with the main menu, and a trailing slot for the account.
 * The current page's menu item gets `aria-current="page"`, a heavier weight,
 * ink color, and an underline. Below 768px the menu moves to a second row.
 */
export function TopBar({ serviceName, homePath, navigationLabel, navigationItems, trailing }: TopBarProps) {
  return (
    <Header>
      <Inner>
        <Brand to={homePath}>{serviceName}</Brand>
        <Navigation aria-label={navigationLabel}>
          <NavigationList>
            {navigationItems.map((item) => (
              <li key={item.path}>
                <NavigationLink to={item.path}>
                  <NavigationLabel data-navigation-label="">{item.label}</NavigationLabel>
                </NavigationLink>
              </li>
            ))}
          </NavigationList>
        </Navigation>
        {trailing !== undefined && <Trailing>{trailing}</Trailing>}
      </Inner>
    </Header>
  );
}
