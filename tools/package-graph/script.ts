import './style.scss';
import graphResource from './resources/graph.json';
import { createGraphContext } from './scripts/context.ts';
import { mountDetails } from './scripts/details.ts';
import { mountDiagram } from './scripts/diagram.ts';
import type { WorkspaceGraph } from './scripts/graph.ts';
import { renderSummary } from './scripts/summary.ts';

const context = createGraphContext(graphResource as WorkspaceGraph);

renderSummary(document.querySelector('#summary') as HTMLElement, context.graph);
mountDetails(document.querySelector('#details') as HTMLElement, context);
mountDiagram(document.querySelector('#diagram') as SVGSVGElement, document.querySelector('#controls') as HTMLElement, context);

const search = document.querySelector('#search') as HTMLInputElement;
search.addEventListener('input', () => context.focus.search(search.value));
search.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const query = search.value.trim().toLowerCase();
  const match = context.graph.nodes.find((node) => node.label.toLowerCase().includes(query));
  if (query.length > 0 && match !== undefined) context.focus.pin(match.name);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') context.focus.clear();
});
