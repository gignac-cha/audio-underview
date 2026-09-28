import type { CategoryEdge, WorkspaceCategory, WorkspaceEdge, WorkspaceNode } from './graph.ts';

/** A rectangle in the drawing's own coordinates. */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export function boxFrom(left: number, top: number, width: number, height: number): Box {
  return {
    left,
    right: left + width,
    top,
    bottom: top + height,
    centerX: left + width / 2,
    centerY: top + height / 2,
  };
}

export interface Route {
  d: string;
  /** Midpoint, for a count label. */
  x: number;
  y: number;
  /** Where the line leaves and arrives, for the jacks drawn at its ends. */
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/**
 * Route between two boxes wherever they are: leave from the side facing the
 * other box and arrive on the side facing back. Boxes stacked in one column get
 * a loop out to the right and back.
 */
export function routeBetween(source: Box, target: Box, startY: number, endY: number): Route {
  const overlapping = Math.abs(source.centerX - target.centerX) < (source.right - source.left) / 2;
  if (overlapping) {
    const startX = source.right;
    const endX = target.right;
    const bend = 48;
    return {
      d: `M${startX},${startY} C${startX + bend},${startY} ${endX + bend},${endY} ${endX},${endY}`,
      x: Math.max(startX, endX) + bend * 0.75,
      y: (startY + endY) / 2,
      start: { x: startX, y: startY },
      end: { x: endX, y: endY },
    };
  }
  const leftward = source.centerX > target.centerX;
  const startX = leftward ? source.left : source.right;
  const endX = leftward ? target.right : target.left;
  const direction = leftward ? -1 : 1;
  const bend = Math.max(40, Math.abs(startX - endX) / 2);
  return {
    d: `M${startX},${startY} C${startX + direction * bend},${startY} ${endX - direction * bend},${endY} ${endX},${endY}`,
    x: (startX + endX) / 2,
    y: (startY + endY) / 2,
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
  };
}

export function categoryEdgeKey(edge: { source: WorkspaceCategory; target: WorkspaceCategory }): string {
  return `${edge.source}>${edge.target}`;
}

/**
 * Where each bundle leaves (`out`) or enters (`in`) its box: several bundles on
 * one box are spread along its side in the order of their other ends, so they
 * do not cross at the box. Returns the y of each port, keyed by {@link categoryEdgeKey}.
 */
export function spreadPorts(
  categoryEdges: CategoryEdge[],
  boxOf: (category: WorkspaceCategory) => Box,
  side: 'out' | 'in',
): Map<string, number> {
  const ports = new Map<string, number>();
  const byCategory = new Map<WorkspaceCategory, CategoryEdge[]>();
  for (const edge of categoryEdges) {
    const owner = side === 'out' ? edge.source : edge.target;
    byCategory.set(owner, [...(byCategory.get(owner) ?? []), edge]);
  }
  for (const [owner, edges] of byCategory) {
    const ownerBox = boxOf(owner);
    const otherEnd = (edge: CategoryEdge) => boxOf(side === 'out' ? edge.target : edge.source).centerY;
    const sorted = [...edges].sort((left, right) => otherEnd(left) - otherEnd(right));
    const band = Math.max(0, Math.min(ownerBox.bottom - ownerBox.top - 24, sorted.length * 26));
    sorted.forEach((edge, index) => {
      const offset = sorted.length === 1 ? 0 : (index / (sorted.length - 1) - 0.5) * band;
      ports.set(categoryEdgeKey(edge), ownerBox.centerY + offset);
    });
  }
  return ports;
}

/** Above this many direct links into one category, they are drawn as one line to the box. */
export const DIRECT_LINES_PER_CATEGORY = 4;

export interface FocusGroup {
  state: 'dependency' | 'dependent';
  category: WorkspaceCategory;
  edges: WorkspaceEdge[];
}

/** The focused workspace's direct links, grouped by direction and neighbour category. */
export function groupFocusEdges(name: string, edges: WorkspaceEdge[], nodeByName: Map<string, WorkspaceNode>): FocusGroup[] {
  const groups = new Map<string, FocusGroup>();
  for (const edge of edges) {
    if (edge.source !== name && edge.target !== name) continue;
    const state = edge.source === name ? 'dependency' : 'dependent';
    const neighbour = nodeByName.get(state === 'dependency' ? edge.target : edge.source) as WorkspaceNode;
    const key = `${state}:${neighbour.category}`;
    const group = groups.get(key) ?? { state, category: neighbour.category, edges: [] };
    group.edges.push(edge);
    groups.set(key, group);
  }
  return [...groups.values()];
}
