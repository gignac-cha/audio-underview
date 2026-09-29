import { describe, expect, it } from 'vitest';
import { createFocusController, type FocusState } from './focus.ts';

const edges = [
  { source: 'worker', target: 'library', development: false },
  { source: 'web', target: 'library', development: false },
];

function record() {
  const calls: { highlight?: string; pinned?: string }[] = [];
  const controller = createFocusController(edges);
  controller.subscribe((highlight: FocusState | undefined, _query: string, pinned: FocusState | undefined) => {
    calls.push({ highlight: highlight?.name, pinned: pinned?.name });
  });
  return { controller, last: () => calls.at(-1) };
}

describe('createFocusController', () => {
  it('highlights on hover without pinning', () => {
    const { controller, last } = record();
    controller.hover('worker');
    expect(last()).toEqual({ highlight: 'worker', pinned: undefined });
  });

  it('keeps the pinned workspace while another one is hovered', () => {
    const { controller, last } = record();
    controller.toggle('library');
    controller.hover('web');
    expect(last()).toEqual({ highlight: 'web', pinned: 'library' });
    controller.leave();
    expect(last()).toEqual({ highlight: 'library', pinned: 'library' });
  });

  it('gives a listener that subscribes later the current selection', () => {
    const controller = createFocusController(edges);
    controller.pin('library');
    let received: string | undefined;
    controller.subscribe((_highlight, _query, pinned) => {
      received = pinned?.name;
    });
    expect(received).toBe('library');
  });

  it('unpins on a second click and on clear', () => {
    const { controller, last } = record();
    controller.toggle('library');
    controller.toggle('library');
    expect(last()).toEqual({ highlight: undefined, pinned: undefined });
    controller.pin('web');
    controller.clear();
    expect(last()).toEqual({ highlight: undefined, pinned: undefined });
  });
});
