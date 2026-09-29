import {
  categoryEdgeKey,
  DIRECT_LINES_PER_CATEGORY,
  groupFocusEdges,
  routeBetween,
  spreadPorts,
  type Box,
} from './category-geometry.ts';
import { escapeHTML, type GraphContext } from './context.ts';
import type { CategoryDefinition, CategoryEdge, WorkspaceCategory, WorkspaceNode } from './graph.ts';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** A package this many others use directly gets its count printed on the chip. */
const BADGE_MINIMUM_DEPENDENTS = 5;

/** Column heading: how far the categories in that column sit above the base. */
export function layerLabel(layer: number): string {
  return layer === 0 ? '다른 카테고리를 쓰지 않음' : `${layer}단계 위`;
}

/** The HTML of one category module: title, description and its packages. */
export function renderBox(category: CategoryDefinition, members: WorkspaceNode[], context: GraphContext): string {
  const columns = members.length >= 10 ? 3 : members.length >= 4 ? 2 : 1;
  const shortLabel = (node: WorkspaceNode) =>
    category.suffix !== undefined && node.label.endsWith(category.suffix) && node.label !== category.suffix
      ? node.label.slice(0, -category.suffix.length)
      : node.label;

  return `
    <section class="category-box" data-category="${category.id}">
      <header>
        <span class="swatch"></span>
        <h3>${escapeHTML(category.label)}</h3>
        <em>${members.length}</em>
        <button type="button" class="collapse" data-action="toggle" aria-expanded="true" aria-label="${escapeHTML(category.label)} 접기">−</button>
      </header>
      <p>${escapeHTML(category.description)}${category.suffix === undefined ? '' : ` 이름 끝의 <code>${escapeHTML(category.suffix)}</code>는 줄였습니다.`}</p>
      <ul class="category-members" style="--columns: ${columns}">
        ${members
          .map((member) => {
            const dependents = context.dependentCounts.get(member.name) ?? 0;
            return `<li><button type="button" class="member" data-name="${escapeHTML(member.name)}" title="${escapeHTML(member.path)}">
              <span class="label">${escapeHTML(shortLabel(member))}</span>${
                dependents >= BADGE_MINIMUM_DEPENDENTS ? `<span class="badge" title="${dependents}곳에서 직접 씀">${dependents}</span>` : ''
              }
            </button></li>`;
          })
          .join('')}
      </ul>
    </section>
  `;
}

export function setCollapsed(box: HTMLElement, collapsed: boolean) {
  box.classList.toggle('collapsed', collapsed);
  const toggle = box.querySelector<HTMLButtonElement>('[data-action="toggle"]');
  if (toggle !== null) {
    toggle.textContent = collapsed ? '+' : '−';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }
}

function countPill(x: number, y: number, count: number, className: string): SVGGElement {
  const pill = document.createElementNS(SVG_NAMESPACE, 'g');
  pill.setAttribute('class', className);
  pill.setAttribute('transform', `translate(${x},${y})`);
  const width = 14 + String(count).length * 7;
  pill.innerHTML = `<rect x="${-width / 2}" y="-9" width="${width}" height="18"></rect><text dy="0.35em" text-anchor="middle">${count}</text>`;
  return pill;
}

/**
 * One cable per category pair, between the sides of the two modules that face
 * each other, spread along each side so cables do not cross at the module, with
 * a jack at each end and the number of package dependencies it carries.
 */
export function drawBundles(
  layer: SVGElement,
  categoryEdges: CategoryEdge[],
  boxOfCategory: (category: WorkspaceCategory) => Box,
  labelOf: (category: WorkspaceCategory) => string,
  focusActive: boolean,
  hoveredCategory: WorkspaceCategory | undefined,
) {
  const boxes = new Map<WorkspaceCategory, Box>();
  const box = (category: WorkspaceCategory) => {
    if (!boxes.has(category)) boxes.set(category, boxOfCategory(category));
    return boxes.get(category) as Box;
  };
  const outPorts = spreadPorts(categoryEdges, box, 'out');
  const inPorts = spreadPorts(categoryEdges, box, 'in');

  for (const edge of [...categoryEdges].reverse()) {
    const key = categoryEdgeKey(edge);
    const route = routeBetween(box(edge.source), box(edge.target), outPorts.get(key) as number, inPorts.get(key) as number);
    const count = edge.edges.length;
    const highlighted = hoveredCategory === edge.source || hoveredCategory === edge.target;

    const group = document.createElementNS(SVG_NAMESPACE, 'g');
    group.setAttribute(
      'class',
      `bundle${highlighted ? ' highlighted' : ''}${hoveredCategory !== undefined && !highlighted ? ' dimmed' : ''}${focusActive ? ' muted' : ''}`,
    );

    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', route.d);
    path.setAttribute('stroke-width', String(1.5 + Math.sqrt(count) * 1.6));
    path.setAttribute('class', 'bundle-line');
    path.setAttribute('data-category', edge.source);

    const title = document.createElementNS(SVG_NAMESPACE, 'title');
    title.textContent = `쓰는 쪽: ${labelOf(edge.source)}\n쓰이는 쪽: ${labelOf(edge.target)}\n패키지 의존 ${count}개`;
    path.append(title);

    const jacks = [route.start, route.end].map((point) => {
      const jack = document.createElementNS(SVG_NAMESPACE, 'circle');
      jack.setAttribute('class', 'jack');
      jack.setAttribute('cx', String(point.x));
      jack.setAttribute('cy', String(point.y));
      jack.setAttribute('r', '4.5');
      jack.setAttribute('data-category', edge.source);
      return jack;
    });

    group.append(path, ...jacks, countPill(route.x, route.y, count, 'bundle-count'));
    layer.append(group);
  }
}

/**
 * Lines for the focused package: its direct dependencies and dependents only.
 * The rest of each path shows as coloured chips. When one category holds many
 * direct neighbours, one line goes to that module with the count on it.
 */
export function drawFocusLines(
  layer: SVGElement,
  name: string,
  context: GraphContext,
  anchorOf: (name: string) => Box,
  categoryBox: (category: WorkspaceCategory) => Box,
) {
  const focused = anchorOf(name);
  for (const group of groupFocusEdges(name, context.reducedEdges, context.nodeByName)) {
    if (group.edges.length <= DIRECT_LINES_PER_CATEGORY) {
      for (const edge of group.edges) {
        drawLine(layer, anchorOf(edge.source), anchorOf(edge.target), `package-line ${group.state}${edge.development ? ' development' : ''}`);
      }
      continue;
    }
    const box = categoryBox(group.category);
    const [source, target] = group.state === 'dependency' ? [focused, box] : [box, focused];
    drawLine(layer, source, target, `package-line ${group.state} folded`);
    // The count sits just outside the side of the module that faces the focused
    // package, where no other module can cover it.
    const pillX = focused.centerX < box.centerX ? box.left - 18 : box.right + 18;
    layer.append(countPill(pillX, box.centerY, group.edges.length, `bundle-count ${group.state}`));
  }
}

function drawLine(layer: SVGElement, source: Box, target: Box, className: string) {
  const path = document.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', routeBetween(source, target, source.centerY, target.centerY).d);
  path.setAttribute('class', className);
  layer.append(path);
}
