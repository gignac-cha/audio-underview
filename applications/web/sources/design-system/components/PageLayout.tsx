import { useLayoutEffect, type ReactNode } from 'react';
import styled from '@emotion/styled';
import { Global, type CSSObject } from '@emotion/react';
import '../fonts.ts';
import {
  color,
  defaultThemeName,
  duration,
  easing,
  fontFamily,
  layer,
  layout,
  media,
  radius,
  space,
  textStyle,
  themes,
  themeVariables,
  type ThemeName,
} from '../tokens.ts';
import { focusRing } from '../styles.ts';
import { NoticeRegion } from './NoticeRegion.tsx';

export type PageArrangement = 'flow' | 'vertically-centered' | 'centered';

export interface PageLayoutProps {
  /** Rendered above `main`, usually `TopBar`. When present, a skip link to the main content is added. */
  header?: ReactNode;
  /** The page content, placed inside the `main` landmark. */
  children: ReactNode;
  /**
   * `flow`: content column (max 72rem) with page gutters, top-aligned.
   * `vertically-centered`: the same column and left edge, centered vertically in
   * the viewport, for short screens without a header. Content taller than the
   * viewport starts at the top instead of being cut off.
   * `centered`: a narrow column centered on both axes.
   */
  arrangement?: PageArrangement;
  /** Theme to render with. Only `light` exists today. */
  theme?: ThemeName;
}

export const MAIN_CONTENT_ID = 'main-content';

/**
 * `index.html` sets this attribute on `<html>` before any script or stylesheet
 * of the app loads, for the paths that render this layout, and paints the
 * canvas color right away so the legacy dark background never flashes.
 * `PageLayout` takes over the canvas once mounted and removes the attribute,
 * so screens without this layout get their own background back.
 */
export const EARLY_CANVAS_ATTRIBUTE = 'data-underview-canvas';

const SKIP_LINK_LABEL = '본문으로 건너뛰기';

const themeRules = Object.fromEntries(
  Object.entries(themes).map(([name, theme]) => [
    `&[data-underview-theme='${name}']`,
    { ...themeVariables(theme), colorScheme: theme.colorScheme },
  ]),
);

const Root = styled.div(themeRules, {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  minHeight: ['100vh', '100dvh'],
  backgroundColor: color.canvas,
  color: color.ink,
  ...textStyle.body,
  wordBreak: 'keep-all',
  overflowWrap: 'anywhere',
  WebkitTextSizeAdjust: '100%',
  textSizeAdjust: '100%',
});

/**
 * Zero-specificity resets inside the new screens: border-box sizing, no
 * default margins, and no legacy link border, hover color, or 0.2s transition
 * from `styles/global.scss` (that transition ignores reduced motion). Any
 * component class overrides them.
 */
const ROOT_RESETS: CSSObject = {
  ':where([data-underview-root]), :where([data-underview-root]) *, :where([data-underview-root]) ::before, :where([data-underview-root]) ::after':
    {
      boxSizing: 'border-box',
    },
  ':where([data-underview-root]) a': {
    borderBottom: 0,
    transition: 'none',
  },
  ':where([data-underview-root]) a:hover': {
    color: 'inherit',
  },
  ':where([data-underview-root]) :where(h1, h2, h3, h4, p, ul, ol, dl, dd, figure)': {
    margin: 0,
  },
};

const Main = styled.main`
  flex: 1;
  width: 100%;
  max-width: ${layout.contentMaxWidth};
  margin: 0 auto;
  padding: ${space[6]} ${layout.gutter.small} ${space[8]};

  &:focus {
    outline: none;
  }

  ${media.medium} {
    padding: ${space[7]} ${layout.gutter.medium} ${space[9]};
  }

  ${media.large} {
    padding-inline: ${layout.gutter.large};
  }

  /* Spacers before and after the content share the free height. They shrink to
     nothing when the content is taller than the viewport, so nothing is cut off. */
  &[data-arrangement='vertically-centered'] {
    display: flex;
    flex-direction: column;

    &::before,
    &::after {
      content: '';
      flex: 1 1 0;
    }
  }

  &[data-arrangement='centered'] {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    max-width: ${layout.readingMaxWidth};
    padding-block: ${space[8]};
  }
`;

const SkipLink = styled.a`
  position: absolute;
  z-index: ${layer.skipLink};
  top: ${space[2]};
  left: ${space[2]};
  display: inline-flex;
  align-items: center;
  padding: ${space[3]} ${space[4]};
  border-radius: ${radius.control};
  background-color: ${color.accent};
  color: ${color.onAccent};
  ${textStyle.label};
  text-decoration: none;
  transform: translateY(calc(-100% - ${space[4]}));
  transition: none;

  ${focusRing}

  &:hover {
    color: ${color.onAccent};
  }

  /* Slides in when focused and leaves at once when focus moves on, so it never
     lingers over the service name. The duration is 0ms under reduced motion. */
  &:focus-visible {
    transform: translateY(0);
    transition: transform ${duration.moderate} ${easing.standard};
  }
`;

/**
 * The page frame for the new screens. It declares the theme's CSS variables,
 * paints the page canvas (only while mounted, so other screens keep their
 * look), loads the fonts, provides the `main` landmark, and renders notices.
 */
export function PageLayout({ header, children, arrangement = 'flow', theme = defaultThemeName }: PageLayoutProps) {
  const activeTheme = themes[theme];

  // Runs after the Global styles below are inserted and before the first paint.
  useLayoutEffect(() => {
    document.documentElement.removeAttribute(EARLY_CANVAS_ATTRIBUTE);
  }, []);

  return (
    <Root data-underview-root="" data-underview-theme={theme}>
      <Global
        styles={{
          ':root': {
            backgroundColor: activeTheme.color.canvas,
            colorScheme: activeTheme.colorScheme,
          },
          ':root body': {
            backgroundColor: activeTheme.color.canvas,
            color: activeTheme.color.ink,
            fontFamily: fontFamily.sans,
          },
          ...ROOT_RESETS,
        }}
      />
      {header !== undefined && <SkipLink href={`#${MAIN_CONTENT_ID}`}>{SKIP_LINK_LABEL}</SkipLink>}
      {header}
      <Main id={MAIN_CONTENT_ID} tabIndex={-1} data-arrangement={arrangement}>
        {children}
      </Main>
      <NoticeRegion />
    </Root>
  );
}
