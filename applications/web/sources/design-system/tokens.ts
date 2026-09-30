/**
 * Design tokens for the sign-in, authentication callback, and home screens.
 *
 * Screens import values from this module only and never write raw colors or
 * pixel lengths. Colors, shadows, and motion durations resolve to CSS custom
 * properties that `PageLayout` declares on its root element, so another theme
 * can be added later by writing one more `Theme` object with the same keys.
 */

type ColorRole =
  | 'canvas'
  | 'surface'
  | 'surfaceHover'
  | 'surfacePressed'
  | 'surfaceSunken'
  | 'ink'
  | 'inkSecondary'
  | 'inkMuted'
  | 'line'
  | 'lineStrong'
  | 'accent'
  | 'accentHover'
  | 'accentPressed'
  | 'accentSoft'
  | 'onAccent'
  | 'danger'
  | 'dangerSoft'
  | 'focusRing'
  | 'skeletonBase'
  | 'skeletonHighlight'
  | 'logoBackground'
  | 'onLogoBackground';

type ShadowRole = 'floating';

type DurationRole = 'quick' | 'moderate' | 'slow' | 'meterCycle' | 'shimmerCycle';

export interface Theme {
  colorScheme: 'light' | 'dark';
  color: Record<ColorRole, string>;
  shadow: Record<ShadowRole, string>;
}

/**
 * Light theme (default).
 *
 * A cool sage-grey canvas with white surfaces and deep pine ink. The deep teal
 * accent is reserved for things a person can press; the brick red is reserved
 * for problems. Every text pairing below meets 4.5:1, and `lineStrong` meets
 * 3:1 against both `surface` and `canvas` for control outlines.
 *
 * `accentHover` and `accentPressed` step down in clear lightness steps
 * (L* 34 → 23 → 15) so hover and press read on a filled button. The focus
 * ring uses the ink color, not the accent, so it stands apart from teal fills.
 * Skeleton bars are dark enough (1.55:1 on `surface`) to read as content that
 * is on its way rather than an empty box.
 *
 * `logoBackground` is the white of the logo chip inside a filled button:
 * Google's brand rules put the standard color "G" on white only. Every theme
 * keeps it white, and `onLogoBackground` (the color of single-color marks such
 * as GitHub's on that chip) keeps it dark (14.0:1), so the chip reads the same
 * whatever the theme around it.
 */
export const lightTheme: Theme = {
  colorScheme: 'light',
  color: {
    canvas: '#EDF0EC',
    surface: '#FBFCFA',
    surfaceHover: '#F2F5F2',
    surfacePressed: '#E6EBE7',
    surfaceSunken: '#E1E6E2',
    ink: '#18302B',
    inkSecondary: '#46574F',
    inkMuted: '#56655F',
    line: '#CBD3CE',
    lineStrong: '#7B8A84',
    accent: '#0B5B53',
    accentHover: '#053E37',
    accentPressed: '#032A25',
    accentSoft: '#D9E8E3',
    onAccent: '#FFFFFF',
    danger: '#A12F1C',
    dangerSoft: '#F7E4DE',
    focusRing: '#18302B',
    skeletonBase: '#C6CFC9',
    skeletonHighlight: '#D9E0DB',
    logoBackground: '#FFFFFF',
    onLogoBackground: '#18302B',
  },
  shadow: {
    floating: '0 0.75rem 2rem -0.5rem rgba(24, 48, 43, 0.22), 0 0.125rem 0.25rem rgba(24, 48, 43, 0.08)',
  },
};

export const themes = {
  light: lightTheme,
} as const satisfies Record<string, Theme>;

export type ThemeName = keyof typeof themes;

export const defaultThemeName: ThemeName = 'light';

const VARIABLE_PREFIX = '--underview';

function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function variableName(group: string, role: string): string {
  return `${VARIABLE_PREFIX}-${group}-${toKebabCase(role)}`;
}

function variableReferences<Role extends string>(group: string, roles: readonly Role[]): Record<Role, string> {
  return Object.fromEntries(roles.map((role) => [role, `var(${variableName(group, role)})`])) as Record<Role, string>;
}

const colorRoles = Object.keys(lightTheme.color) as ColorRole[];
const shadowRoles = Object.keys(lightTheme.shadow) as ShadowRole[];

/** Theme-aware colors. Each value is a `var(--underview-color-*)` reference. */
export const color = variableReferences('color', colorRoles);

/** Theme-aware shadows. Only floating layers (notices) cast a shadow. */
export const shadow = variableReferences('shadow', shadowRoles);

/** Raw motion durations. Use `duration` in components so reduced motion applies. */
export const durationValue: Record<DurationRole, string> = {
  quick: '120ms',
  moderate: '200ms',
  slow: '320ms',
  meterCycle: '1100ms',
  shimmerCycle: '1600ms',
};

const durationRoles = Object.keys(durationValue) as DurationRole[];

/**
 * Motion durations. Each value is a `var(--underview-duration-*)` reference
 * that becomes `0ms` under `prefers-reduced-motion: reduce`.
 */
export const duration = variableReferences('duration', durationRoles);

export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

export const fontFamily = {
  sans: "'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
} as const;

/**
 * Type scale from the classic typographic scale (14, 16, 18, 21, 24, 36, 60).
 * `heading1` and `display` grow with the viewport between 360px and 1280px.
 */
export const fontSize = {
  small: '0.875rem',
  body: '1rem',
  lead: '1.125rem',
  heading3: '1.3125rem',
  heading2: '1.5rem',
  heading1: 'clamp(1.75rem, 1.4rem + 1.5vw, 2.25rem)',
  display: 'clamp(2.5rem, 1.6rem + 4vw, 3.75rem)',
} as const;

/** Korean text needs more leading than Latin text, so body copy runs at 1.7. */
export const lineHeight = {
  tight: 1.15,
  heading: 1.35,
  compact: 1.45,
  body: 1.7,
} as const;

export const letterSpacing = {
  display: '-0.025em',
  heading: '-0.012em',
  normal: '0',
} as const;

/**
 * Ready-made text styles. Spread into object styles or interpolate into `styled` templates.
 * Headings balance their line lengths; body text avoids a lone last word.
 */
export const textStyle = {
  display: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.display,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.tight,
    letterSpacing: letterSpacing.display,
    textWrap: 'balance',
  },
  heading1: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.heading1,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.heading,
    letterSpacing: letterSpacing.heading,
    textWrap: 'balance',
  },
  heading2: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.heading2,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.heading,
    letterSpacing: letterSpacing.heading,
    textWrap: 'balance',
  },
  heading3: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.heading3,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.heading,
    letterSpacing: letterSpacing.heading,
    textWrap: 'balance',
  },
  lead: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.lead,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.body,
    letterSpacing: letterSpacing.normal,
    textWrap: 'pretty',
  },
  body: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.body,
    letterSpacing: letterSpacing.normal,
    textWrap: 'pretty',
  },
  label: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.compact,
    letterSpacing: letterSpacing.normal,
  },
  small: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.small,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.compact,
    letterSpacing: letterSpacing.normal,
  },
} as const;

/** Spacing steps on a 4px grid: 4, 8, 12, 16, 24, 32, 48, 64, 96. */
export const space = {
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.5rem',
  6: '2rem',
  7: '3rem',
  8: '4rem',
  9: '6rem',
} as const;

/**
 * Component dimensions. `touchTarget` is the 44px minimum for anything pressable.
 * `listRow` is the height of one row in a list surface: one `touchTarget` plus
 * `space[2]` above and below, so a row that holds a button is exactly as tall
 * as a row that holds only text. Lists reserve room in multiples of it so the
 * content below does not move when rows arrive.
 * `logoChip` is the white tile that holds a provider mark inside a large
 * button: a fixed `iconLarge` mark with `space[2]` of white on every side
 * (8 + 24 + 8). In the 56px `controlLarge` button it sits `space[2]` from the
 * top, bottom, and start edges.
 */
export const size = {
  touchTarget: '2.75rem',
  controlLarge: '3.5rem',
  listRow: '3.75rem',
  iconRegular: '1.25rem',
  iconLarge: '1.5rem',
  logoChip: '2.5rem',
  avatarSmall: '2rem',
  avatarLarge: '4.5rem',
  borderWidth: '1px',
  focusRingWidth: '0.1875rem',
  focusRingOffset: '0.125rem',
  currentIndicator: '0.1875rem',
} as const;

/**
 * Rounded corners: small for things you press, larger for things that hold
 * content. `logoChip` is tighter than `control` because the chip sits just
 * inside a button's corner.
 */
export const radius = {
  control: '0.375rem',
  logoChip: '0.25rem',
  container: '0.625rem',
  round: '50%',
} as const;

export const layout = {
  contentMaxWidth: '72rem',
  readingMaxWidth: '38rem',
  noticeMaxWidth: '24rem',
  accountNameMaxWidth: '14rem',
  gutter: {
    small: space[4],
    medium: space[6],
    large: space[7],
  },
} as const;

/** Breakpoints: below `medium` is the 360px phone layout, `medium` is 768px, `extraLarge` is 1280px. */
export const media = {
  medium: '@media (min-width: 48rem)',
  large: '@media (min-width: 64rem)',
  extraLarge: '@media (min-width: 80rem)',
  reducedMotion: '@media (prefers-reduced-motion: reduce)',
  forcedColors: '@media (forced-colors: active)',
  hover: '@media (hover: hover)',
} as const;

export const layer = {
  topBar: 10,
  skipLink: 50,
  notice: 100,
} as const;

/** How long a notice stays before it closes itself. The timer pauses while it is hovered or focused. */
export const noticeVisibleMilliseconds = 8000;

/**
 * CSS custom properties for a theme, including motion durations and their
 * reduced-motion overrides. `PageLayout` puts these on its root element.
 */
export function themeVariables(theme: Theme): Record<string, string | Record<string, string>> {
  const colorVariables = Object.fromEntries(
    colorRoles.map((role) => [variableName('color', role), theme.color[role]]),
  );
  const shadowVariables = Object.fromEntries(
    shadowRoles.map((role) => [variableName('shadow', role), theme.shadow[role]]),
  );
  const durationVariables = Object.fromEntries(
    durationRoles.map((role) => [variableName('duration', role), durationValue[role]]),
  );
  const reducedDurationVariables = Object.fromEntries(
    durationRoles.map((role) => [variableName('duration', role), '0ms']),
  );

  return {
    ...colorVariables,
    ...shadowVariables,
    ...durationVariables,
    [media.reducedMotion]: reducedDurationVariables,
  };
}
