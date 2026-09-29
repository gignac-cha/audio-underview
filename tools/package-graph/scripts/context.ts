import { reduceTransitively, type WorkspaceEdge, type WorkspaceGraph, type WorkspaceNode } from './graph.ts';
import { createFocusController, type FocusController } from './focus.ts';

export interface GraphContext {
  graph: WorkspaceGraph;
  nodeByName: Map<string, WorkspaceNode>;
  /** Edges with every shortcut an existing path already covers removed. */
  reducedEdges: WorkspaceEdge[];
  /** How many packages use each package directly. */
  dependentCounts: Map<string, number>;
  focus: FocusController;
}

export function createGraphContext(graph: WorkspaceGraph): GraphContext {
  const dependentCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    dependentCounts.set(edge.target, (dependentCounts.get(edge.target) ?? 0) + 1);
  }

  return {
    graph,
    nodeByName: new Map(graph.nodes.map((node) => [node.name, node])),
    reducedEdges: reduceTransitively(graph.edges),
    dependentCounts,
    focus: createFocusController(graph.edges),
  };
}

export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}
