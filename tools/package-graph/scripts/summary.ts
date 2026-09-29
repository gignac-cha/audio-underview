import type { WorkspaceGraph } from './graph.ts';

export function renderSummary(element: HTMLElement, graph: WorkspaceGraph) {
  element.textContent = `패키지 ${graph.nodes.length}개가 서로 ${graph.edges.length}번 의존합니다.`;
}
