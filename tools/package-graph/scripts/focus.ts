import { collectReachable, type WorkspaceEdge } from './graph.ts';

export interface FocusState {
  name: string;
  pinned: boolean;
  dependencies: Set<string>;
  dependents: Set<string>;
}

/**
 * `focus` is what to highlight (the hovered workspace, else the pinned one).
 * `pinned` is only the clicked one — the details panel follows it alone, so a
 * hover never opens or closes the panel and never shifts the layout.
 */
export type FocusListener = (focus: FocusState | undefined, query: string, pinned: FocusState | undefined) => void;

export interface FocusController {
  hover(name: string): void;
  leave(): void;
  toggle(name: string): void;
  pin(name: string): void;
  clear(): void;
  search(query: string): void;
  subscribe(listener: FocusListener): void;
}

/**
 * One selection shared by every tab: hovering previews a workspace, clicking
 * pins it, and the pinned one survives a tab switch.
 */
export function createFocusController(edges: WorkspaceEdge[]): FocusController {
  const listeners: FocusListener[] = [];
  let pinned: string | undefined;
  let hovered: string | undefined;
  let query = '';

  const stateOf = (name: string | undefined): FocusState | undefined =>
    name === undefined
      ? undefined
      : {
          name,
          pinned: name === pinned,
          dependencies: collectReachable(name, edges, 'dependencies'),
          dependents: collectReachable(name, edges, 'dependents'),
        };

  const current = (): [FocusState | undefined, FocusState | undefined] => {
    const focus = stateOf(hovered ?? pinned);
    const pinnedState = hovered === undefined || hovered === pinned ? (focus?.pinned ? focus : undefined) : stateOf(pinned);
    return [focus, pinnedState];
  };

  const emit = () => {
    const [focus, pinnedState] = current();
    for (const listener of listeners) {
      listener(focus, query, pinnedState);
    }
  };

  return {
    hover(name) {
      hovered = name;
      emit();
    },
    leave() {
      hovered = undefined;
      emit();
    },
    toggle(name) {
      pinned = pinned === name ? undefined : name;
      hovered = undefined;
      emit();
    },
    pin(name) {
      pinned = name;
      hovered = undefined;
      emit();
    },
    clear() {
      pinned = undefined;
      hovered = undefined;
      emit();
    },
    search(nextQuery) {
      query = nextQuery.trim().toLowerCase();
      emit();
    },
    subscribe(listener) {
      listeners.push(listener);
      // A tab mounted later starts from the selection that already exists.
      const [focus, pinnedState] = current();
      listener(focus, query, pinnedState);
    },
  };
}
