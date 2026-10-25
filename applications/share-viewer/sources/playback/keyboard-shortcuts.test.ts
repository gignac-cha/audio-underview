import { describe, expect, it } from 'vitest';
import { SEEK_STEP_SECONDS, resolveShortcutAction } from './keyboard-shortcuts.ts';

const plainTarget = { tagName: 'DIV', isContentEditable: false };

describe('SEEK_STEP_SECONDS', () => {
  it('is the ten seconds the on-screen skip buttons also move', () => {
    expect(SEEK_STEP_SECONDS).toBe(10);
  });
});

describe('resolveShortcutAction', () => {
  it('maps Space to toggle and arrows to seeks on a plain target', () => {
    expect(resolveShortcutAction('Space', plainTarget)).toBe('toggle-playback');
    expect(resolveShortcutAction('ArrowRight', plainTarget)).toBe('seek-forward');
    expect(resolveShortcutAction('ArrowLeft', plainTarget)).toBe('seek-backward');
  });

  it('ignores unrelated keys', () => {
    expect(resolveShortcutAction('KeyA', plainTarget)).toBeNull();
    expect(resolveShortcutAction('Enter', plainTarget)).toBeNull();
    expect(resolveShortcutAction('ArrowUp', plainTarget)).toBeNull();
  });

  it('swallows every shortcut while a typing surface is focused', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const target = { tagName, isContentEditable: false };
      expect(resolveShortcutAction('Space', target)).toBeNull();
      expect(resolveShortcutAction('ArrowRight', target)).toBeNull();
      expect(resolveShortcutAction('ArrowLeft', target)).toBeNull();
    }
    const editable = { tagName: 'DIV', isContentEditable: true };
    expect(resolveShortcutAction('Space', editable)).toBeNull();
  });

  it('ignores Space on buttons and links but keeps arrow seeks there', () => {
    for (const tagName of ['BUTTON', 'A']) {
      const target = { tagName, isContentEditable: false };
      expect(resolveShortcutAction('Space', target)).toBeNull();
      expect(resolveShortcutAction('ArrowRight', target)).toBe('seek-forward');
      expect(resolveShortcutAction('ArrowLeft', target)).toBe('seek-backward');
    }
  });

  it('handles a null target (window-level events) as a plain surface', () => {
    expect(resolveShortcutAction('Space', null)).toBe('toggle-playback');
    expect(resolveShortcutAction('ArrowLeft', null)).toBe('seek-backward');
  });
});
