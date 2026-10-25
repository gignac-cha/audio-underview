/**
 * Global playback shortcuts: Space toggles play/pause, ArrowLeft/ArrowRight
 * skip along the whole-newscast timeline.
 *
 * The resolution is a pure function so the filtering rules are unit-testable:
 * typing surfaces (inputs, textareas, selects, contenteditable) swallow every
 * shortcut, and Space is additionally ignored on buttons and links because the
 * browser already activates those with Space — a global toggle on top would
 * fire the action twice.
 */

/**
 * One skip, in seconds. Deliberately the SAME number the on-screen ±버튼 use:
 * a reader who learns "one tap is ten seconds" from the buttons must get the
 * same distance from the arrow keys.
 */
export const SEEK_STEP_SECONDS = 10;

export type ShortcutAction = 'toggle-playback' | 'seek-forward' | 'seek-backward';

export interface ShortcutTargetLike {
  tagName: string;
  isContentEditable: boolean;
}

export function resolveShortcutAction(
  code: string,
  target: ShortcutTargetLike | null,
): ShortcutAction | null {
  if (target !== null) {
    const tagName = target.tagName;
    if (
      tagName === 'INPUT' ||
      tagName === 'TEXTAREA' ||
      tagName === 'SELECT' ||
      target.isContentEditable
    ) {
      return null;
    }
    if (code === 'Space' && (tagName === 'BUTTON' || tagName === 'A')) {
      return null;
    }
  }

  if (code === 'Space') {
    return 'toggle-playback';
  }
  if (code === 'ArrowRight') {
    return 'seek-forward';
  }
  if (code === 'ArrowLeft') {
    return 'seek-backward';
  }
  return null;
}
