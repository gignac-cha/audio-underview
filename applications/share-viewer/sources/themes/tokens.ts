/**
 * The share viewer's colour system, derived from the final favicon artwork
 * (documents/favicon-candidates/candidate-78.png): dusty blue as the brand
 * hue, cream paper as the light ground, deep navy ink as the dark ground, and
 * the microphone's mustard gold as the single accent that marks "this is what
 * is playing right now".
 *
 * The hex values are the ones fixed in the design doc §5.4 — they are a brand
 * contract, not a starting point. If a contrast fix is ever needed, adjust
 * within the same family and update the doc.
 *
 * MEASURED CONTRAST (WCAG relative luminance, computed against the real hexes;
 * the speaker colours carry 11px bold labels, so the bar is AA 4.5:1, not 3:1):
 *
 *   light speaker1 #4f6a94  background 5.00  surface 5.49
 *   light speaker2 #8f5933  background 5.24  surface 5.76
 *   dark  speaker1 #8ba6cc  background 6.79  surface 5.79
 *   dark  speaker2 #e0a97e  background 8.18  surface 6.97
 *   accentInk on accent     light 5.89  dark 8.02
 *   light accentText #8b530e  accentSoft 5.00  surface 6.28  surfaceAlternate 5.17  background 5.71
 *   dark  accentText #e8a63f  accentSoft 5.11  surface 6.85  surfaceAlternate 4.97  background 8.02
 *
 * `speaker2` light is the one value the research doc left open ("#a2653a 근방,
 * AA 실측 후 확정"): #a2653a measures 4.28 on the cream `background`, i.e. it
 * fails, so it is darkened one step within the same terracotta family to
 * #8f5933. The dark-theme terracotta needed no change.
 *
 * `accentText` exists because `accent` itself is unusable as small text on a
 * light ground — the doc's own rule (§7) — and the numbers say so: light
 * `accent` #dc9127 measures 2.06 on the `accentSoft` wash of the line being
 * spoken and 2.59 on `surface`, nowhere near the 4.5 that 17px text needs. So
 * the mustard is taken to reading lightness while keeping its hue: #8b530e is
 * the accent's own hue (33°) at L 30% instead of L 51%. In the dark theme the
 * accent is already legible against every ground it lands on, so `accentText`
 * is the accent unchanged there; the two tokens are only allowed to diverge for
 * this reason. Backgrounds a spoken word can actually sit on are all measured
 * above: `accentSoft` (the wash), `surface` (the transcript card), and
 * `surfaceAlternate` (the same line under hover, which replaces the wash).
 *
 * Known and deliberate: over the `accentSoft` fill of the line being spoken the
 * same labels measure 4.38 (light speaker1) and 4.32 (dark speaker1) — just
 * under AA. `textSecondary` is in the same position (4.31 light on accentSoft,
 * 4.45 on surfaceAlternate), so this is a property of the wash, not of the
 * speaker family, and moving it belongs to a palette pass over `accentSoft`
 * rather than to a nudge of one token.
 */

export interface ThemeColours {
  background: string;
  surface: string;
  surfaceAlternate: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  brandPrimary: string;
  brandPrimaryStrong: string;
  /** Progress bar and other mustard FILLS — never small text on a light ground. */
  accent: string;
  /**
   * The mustard when it has to BE text: the same hue taken down to a lightness
   * that clears AA at body size. Use it for the word being spoken and any other
   * small "this is now" text; `accent` stays for fills.
   */
  accentText: string;
  /** Background wash behind the line currently being spoken. */
  accentSoft: string;
  /**
   * The ink to put ON an `accent` fill. Mustard is a light colour in both
   * themes, so this is a dark value in both — never `textPrimary`, which is
   * cream in the dark theme and would leave 1.67:1 text on a mustard chip.
   */
  accentInk: string;
  focusRing: string;
  /** Anchor 1's voice colour — the dusty-blue figure of the favicon duo. */
  speaker1: string;
  /** Anchor 2's voice colour — the warm-tan figure of the favicon duo. */
  speaker2: string;
}

export interface ViewerTheme {
  name: 'light' | 'dark';
  colours: ThemeColours;
}

export const LIGHT_THEME: ViewerTheme = {
  name: 'light',
  colours: {
    background: '#faf3ec',
    surface: '#ffffff',
    surfaceAlternate: '#f3e7db',
    textPrimary: '#1c2635',
    textSecondary: '#5d6b80',
    border: '#e3d3c2',
    brandPrimary: '#4f6a94',
    brandPrimaryStrong: '#455d84',
    accent: '#dc9127',
    accentText: '#8b530e',
    accentSoft: '#f7e3c2',
    accentInk: '#1c2635',
    focusRing: '#708cb5',
    speaker1: '#4f6a94',
    speaker2: '#8f5933',
  },
};

export const DARK_THEME: ViewerTheme = {
  name: 'dark',
  colours: {
    background: '#151d2a',
    surface: '#1f2a3c',
    surfaceAlternate: '#2f405a',
    textPrimary: '#f2e2d2',
    textSecondary: '#a9b4c6',
    border: '#3a4a63',
    brandPrimary: '#8ba6cc',
    brandPrimaryStrong: '#a9bfdd',
    accent: '#e8a63f',
    accentText: '#e8a63f',
    accentSoft: 'rgba(220, 145, 39, 0.18)',
    accentInk: '#151d2a',
    focusRing: '#8ba6cc',
    speaker1: '#8ba6cc',
    speaker2: '#e0a97e',
  },
};

/**
 * What the reader picked. `system` is a real third state, not a synonym for one
 * of the other two: it keeps following the OS setting as it changes.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

/** The single localStorage key this application is allowed to write. */
export const THEME_STORAGE_KEY = 'audio-underview:share-viewer:theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Resolve a preference plus the current OS setting into a concrete theme. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ViewerTheme {
  if (preference === 'light') {
    return LIGHT_THEME;
  }
  if (preference === 'dark') {
    return DARK_THEME;
  }
  return systemPrefersDark ? DARK_THEME : LIGHT_THEME;
}
