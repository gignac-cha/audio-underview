/** Mac 여부 — 단축키 라벨(⌘ vs Ctrl)과 modifier 판정에 사용. */
export const isMacPlatform = (): boolean => {
  if (typeof navigator === 'undefined') {
    return false;
  }
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
};

export const modifierKeyLabel = (): string => (isMacPlatform() ? '⌘' : 'Ctrl');

/** 단축키 라벨 생성 (예: `⌘S` / `Ctrl+S`). */
export const shortcutLabel = (key: string): string => {
  const modifier = modifierKeyLabel();
  return modifier === '⌘' ? `⌘${key}` : `Ctrl+${key}`;
};

/** keydown 이벤트가 플랫폼 modifier(⌘ 또는 Ctrl)를 눌렀는지. */
export const isModifierPressed = (event: KeyboardEvent): boolean =>
  isMacPlatform() ? event.metaKey : event.ctrlKey;
