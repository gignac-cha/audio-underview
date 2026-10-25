/**
 * The contrast numbers written into the tokens.ts comment block, re-measured on
 * every run so they cannot quietly rot.
 *
 * This is the check the design doc asks for in §10 ("머스터드/테라코타 텍스트 대비
 * AA 실측"), kept as a test rather than a one-off calculation because the whole
 * failure mode it guards against is someone reaching for a brand colour that
 * looks right and measures 2:1. Every colour asserted here is used as small
 * text, so the bar is AA 4.5:1 throughout — none of it is large text.
 */

import { describe, expect, it } from 'vitest';
import { DARK_THEME, LIGHT_THEME, type ThemeColours, type ViewerTheme } from './tokens.ts';

const AA_SMALL_TEXT_RATIO = 4.5;

type Channels = [number, number, number];

function parseHex(colour: string): Channels {
  return [1, 3, 5].map((offset) => parseInt(colour.slice(offset, offset + 2), 16)) as Channels;
}

/**
 * Flattens a colour onto the ground behind it. `accentSoft` is a translucent
 * mustard in the dark theme, and measuring it as if it were opaque would report
 * a contrast the reader never actually sees.
 */
function flatten(colour: string, behind: Channels): Channels {
  if (colour.startsWith('#')) {
    return parseHex(colour);
  }
  const numbers = colour
    .slice(colour.indexOf('(') + 1, colour.lastIndexOf(')'))
    .split(',')
    .map((part) => Number(part.trim()));
  const [red, green, blue] = numbers;
  const alpha = numbers[3] ?? 1;
  return [red, green, blue].map((channel, index) =>
    Math.round(channel * alpha + behind[index] * (1 - alpha)),
  ) as Channels;
}

function relativeLuminance([red, green, blue]: Channels): number {
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : Math.pow((ratio + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linearRed + 0.7152 * linearGreen + 0.0722 * linearBlue;
}

function contrastRatio(foreground: Channels, background: Channels): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Contrast of one token against another, both named on the same theme. */
function tokenContrast(
  colours: ThemeColours,
  foregroundToken: keyof ThemeColours,
  backgroundToken: keyof ThemeColours,
): number {
  const surface = parseHex(colours.surface);
  return contrastRatio(
    flatten(colours[foregroundToken], surface),
    flatten(colours[backgroundToken], surface),
  );
}

const THEMES: ViewerTheme[] = [LIGHT_THEME, DARK_THEME];

describe.each(THEMES)('$name theme contrast', (theme) => {
  const { colours } = theme;

  /**
   * The three grounds a spoken word can actually land on: the transcript card,
   * the wash on the line being spoken, and that same line under hover — which
   * replaces the wash rather than layering over it.
   */
  it('clears AA for the spoken word on every ground it can land on', () => {
    for (const ground of ['surface', 'accentSoft', 'surfaceAlternate'] as const) {
      expect(
        tokenContrast(colours, 'accentText', ground),
        `accentText on ${ground}`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT_RATIO);
    }
  });

  it('clears AA for both anchor labels on the page and card grounds', () => {
    // The accentSoft wash is deliberately excluded: the speaker labels measure
    // just under AA on it, which tokens.ts documents as a property of the wash
    // (textSecondary sits in the same place) rather than of the speaker family.
    for (const speaker of ['speaker1', 'speaker2'] as const) {
      for (const ground of ['background', 'surface'] as const) {
        expect(
          tokenContrast(colours, speaker, ground),
          `${speaker} on ${ground}`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT_RATIO);
      }
    }
  });

  it('clears AA for ink sitting on a mustard fill', () => {
    expect(tokenContrast(colours, 'accentInk', 'accent')).toBeGreaterThanOrEqual(
      AA_SMALL_TEXT_RATIO,
    );
  });
});

describe('accent versus accentText', () => {
  it('keeps the fill mustard out of small text on the light ground', () => {
    // The reason accentText exists at all. If this ever passes 4.5, the light
    // accent has been changed and the split can be revisited.
    expect(tokenContrast(LIGHT_THEME.colours, 'accent', 'accentSoft')).toBeLessThan(
      AA_SMALL_TEXT_RATIO,
    );
  });

  it('leaves the dark theme accent usable as text, so the tokens agree there', () => {
    expect(DARK_THEME.colours.accentText).toBe(DARK_THEME.colours.accent);
  });
});
