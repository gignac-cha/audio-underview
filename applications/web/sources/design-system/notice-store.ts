import { useSyncExternalStore } from 'react';

/**
 * Notices for the new screens.
 *
 * The store lives at module level, so a notice raised on one screen survives a
 * route change and appears on the next screen that renders `PageLayout`
 * (for example: the authentication callback fails, navigates to `/sign/in`,
 * and the sign-in screen shows the notice). No provider is needed.
 */

export type NoticeTone = 'error' | 'information';

export interface Notice {
  id: string;
  tone: NoticeTone;
  title: string;
  description?: string;
}

export interface NoticeInput {
  title: string;
  description?: string;
  tone?: NoticeTone;
}

type Listener = () => void;

let notices: readonly Notice[] = [];
const listeners = new Set<Listener>();
let sequence = 0;

function publish(next: readonly Notice[]): void {
  notices = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly Notice[] {
  return notices;
}

/**
 * Shows a notice and returns its ID. Showing a notice with the same tone,
 * title, and description again replaces the earlier one instead of stacking,
 * so repeated presses do not pile up copies.
 */
export function showNotice({ title, description, tone = 'error' }: NoticeInput): string {
  sequence += 1;
  const id = `notice-${sequence}`;
  const remaining = notices.filter(
    (notice) => !(notice.tone === tone && notice.title === title && notice.description === description),
  );
  publish([...remaining, { id, tone, title, description }]);
  return id;
}

export function dismissNotice(id: string): void {
  if (!notices.some((notice) => notice.id === id)) {
    return;
  }
  publish(notices.filter((notice) => notice.id !== id));
}

/** Removes every notice. Tests call this between cases. */
export function clearNotices(): void {
  if (notices.length === 0) {
    return;
  }
  publish([]);
}

export function getNotices(): readonly Notice[] {
  return notices;
}

export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
