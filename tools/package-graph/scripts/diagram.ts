import * as d3 from 'd3';
import { drawBundles, drawFocusLines, layerLabel, renderBox, setCollapsed } from './category-drawing.ts';
import { boxFrom, type Box } from './category-geometry.ts';
import type { GraphContext } from './context.ts';
import type { FocusState } from './focus.ts';
import { aggregateCategoryEdges, computeCategoryLayers, type WorkspaceCategory, type WorkspaceNode } from './graph.ts';
import { loadPositions, savePositions, type Position } from './storage.ts';

const BOX_WIDTH = 300;
const COLUMN_GAP = 110;
const ROW_GAP = 24;
const TOP = 36;
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const POSITIONS_STORAGE_KEY = 'package-graph:positions';

/**
 * The package relationship diagram. Packages are grouped into category modules
 * laid out left to right by dependency, and the dependencies between two
 * categories travel as one cable. d3-zoom gives wheel zoom and background
 * panning, d3-drag moves modules in zoomed coordinates, and module contents are
 * HTML inside `<foreignObject>` so they keep the CSS layout.
 *
 * `controls` holds the buttons with `data-action` fit, reset-layout,
 * expand-all and collapse-all.
 */
export function mountDiagram(svgElement: SVGSVGElement, controls: HTMLElement, context: GraphContext) {
  const { graph } = context;
  const categoryEdges = aggregateCategoryEdges(graph.nodes, context.reducedEdges);
  const layers = computeCategoryLayers(
    graph.categories.map((category) => category.id),
    categoryEdges,
  );
  const labelOf = (category: WorkspaceCategory) =>
    graph.categories.find((definition) => definition.id === category)?.label ?? category;
  const membersOf = (category: WorkspaceCategory) =>
    graph.nodes.filter((node) => node.category === category).sort((left, right) => left.label.localeCompare(right.label));

  const svg = d3.select(svgElement);
  const viewport = svg.append('g');
  const lineLayer = viewport.append('g').attr('class', 'category-lines');
  const boxLayer = viewport.append('g').attr('class', 'category-boxes');

  const categories = graph.categories.map((category) => category.id);
  const boxGroups = boxLayer
    .selectAll<SVGGElement, WorkspaceCategory>('g')
    .data(categories)
    .join('g')
    .attr('class', 'category-node');

  const sections = new Map<WorkspaceCategory, HTMLElement>();
  const heights = new Map<WorkspaceCategory, number>();
  boxGroups.each(function (category) {
    const foreignObject = d3.select(this).append('foreignObject').attr('width', BOX_WIDTH).attr('height', 10);
    const holder = document.createElementNS(XHTML_NAMESPACE, 'div') as HTMLDivElement;
    holder.className = 'category-holder';
    holder.innerHTML = renderBox(
      graph.categories.find((definition) => definition.id === category) as (typeof graph.categories)[number],
      membersOf(category),
      context,
    );
    (foreignObject.node() as SVGForeignObjectElement).append(holder);
    sections.set(category, holder.querySelector('.category-box') as HTMLElement);
  });

  const measure = () => {
    boxGroups.each(function (category) {
      const height = (sections.get(category) as HTMLElement).offsetHeight;
      heights.set(category, height);
      d3.select(this).select('foreignObject').attr('height', height + 2);
    });
  };
  measure();

  // Positions: the layered default, overridden by anything the user dragged.
  const defaultPositions = new Map<WorkspaceCategory, Position>();
  const layerCount = Math.max(0, ...layers.values()) + 1;
  for (let layer = 0; layer < layerCount; layer += 1) {
    let y = TOP;
    for (const category of categories.filter((candidate) => layers.get(candidate) === layer)) {
      defaultPositions.set(category, { x: layer * (BOX_WIDTH + COLUMN_GAP), y });
      y += (heights.get(category) ?? 0) + ROW_GAP;
    }
  }
  const saved = loadPositions(POSITIONS_STORAGE_KEY);
  const positions = new Map<WorkspaceCategory, Position>(
    categories.map((category) => [category, { ...(saved.get(category) ?? defaultPositions.get(category) ?? { x: 0, y: 0 }) }]),
  );

  viewport
    .insert('g', ':first-child')
    .attr('class', 'layer-labels')
    .selectAll('text')
    .data(Array.from({ length: layerCount }, (_unused, layer) => layer))
    .join('text')
    .attr('x', (layer) => layer * (BOX_WIDTH + COLUMN_GAP))
    .attr('y', TOP - 14)
    .text(layerLabel);

  const placeBoxes = () => {
    boxGroups.attr('transform', (category) => {
      const position = positions.get(category) as Position;
      return `translate(${position.x},${position.y})`;
    });
  };

  const boxOfCategory = (category: WorkspaceCategory): Box => {
    const position = positions.get(category) as Position;
    return boxFrom(position.x, position.y, BOX_WIDTH, heights.get(category) ?? 0);
  };

  /** A package's anchor in drawing coordinates: its chip, or the module header when folded. */
  const anchorOf = (name: string): Box => {
    const node = context.nodeByName.get(name) as WorkspaceNode;
    const section = sections.get(node.category) as HTMLElement;
    const position = positions.get(node.category) as Position;
    const header = section.querySelector('header') as HTMLElement;
    const target = section.classList.contains('collapsed')
      ? header
      : ((section.querySelector(`[data-name="${CSS.escape(name)}"]`) as HTMLElement | null) ?? header);
    // offsetLeft/Top are relative to the module (position: relative) and are
    // unaffected by the zoom transform.
    return boxFrom(position.x + target.offsetLeft, position.y + target.offsetTop, target.offsetWidth, target.offsetHeight);
  };

  let currentFocus: FocusState | undefined;
  let hoveredCategory: WorkspaceCategory | undefined;

  const draw = () => {
    const layer = lineLayer.node() as SVGGElement;
    layer.replaceChildren();
    const focusActive = currentFocus !== undefined;
    svg.classed('has-focus', focusActive);
    drawBundles(layer, categoryEdges, boxOfCategory, labelOf, focusActive, hoveredCategory);
    if (currentFocus !== undefined) {
      drawFocusLines(layer, currentFocus.name, context, anchorOf, boxOfCategory);
    }
  };

  placeBoxes();
  draw();

  // Zoom: the wheel works everywhere, a press pans only on empty space so it
  // never competes with dragging a module or clicking a package.
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.25, 2.5])
    .filter((event: Event) => {
      if (event.type === 'wheel') return true;
      return !(event as MouseEvent).button && (event.target as Element).closest('.category-node') === null;
    })
    .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => viewport.attr('transform', event.transform.toString()));
  svg.call(zoom).on('dblclick.zoom', null);

  const fit = () => {
    const width = svgElement.clientWidth;
    const height = svgElement.clientHeight;
    if (width === 0 || height === 0) return;
    const boxes = categories.map(boxOfCategory);
    const minimumX = Math.min(...boxes.map((box) => box.left)) - 60;
    const maximumX = Math.max(...boxes.map((box) => box.right)) + 60;
    const minimumY = Math.min(...boxes.map((box) => box.top)) - 40;
    const maximumY = Math.max(...boxes.map((box) => box.bottom)) + 30;
    const scale = Math.min(1.2, width / (maximumX - minimumX), height / (maximumY - minimumY));
    svg
      .transition()
      .duration(350)
      .call(
        zoom.transform,
        d3.zoomIdentity
          .translate(width / 2, height / 2)
          .scale(scale)
          .translate(-(minimumX + maximumX) / 2, -(minimumY + maximumY) / 2),
      );
  };

  // Drag modules; presses on packages and buttons stay clicks.
  boxGroups.call(
    d3
      .drag<SVGGElement, WorkspaceCategory>()
      .filter((event: MouseEvent) => !event.button && (event.target as Element).closest('.member, button') === null)
      .clickDistance(4)
      .on('start', function () {
        d3.select(this).raise();
        (this.querySelector('.category-box') as HTMLElement).classList.add('dragging');
      })
      .on('drag', (event: d3.D3DragEvent<SVGGElement, WorkspaceCategory, WorkspaceCategory>, category) => {
        const position = positions.get(category) as Position;
        position.x += event.dx;
        position.y += event.dy;
        placeBoxes();
        draw();
      })
      .on('end', function () {
        (this.querySelector('.category-box') as HTMLElement).classList.remove('dragging');
        savePositions(POSITIONS_STORAGE_KEY, positions);
      }),
  );

  // Hover and click, delegated from the whole drawing.
  svgElement.addEventListener('mouseover', (event) => {
    const target = event.target as HTMLElement;
    const chip = target.closest<HTMLElement>('.member');
    if (chip?.dataset.name !== undefined) {
      context.focus.hover(chip.dataset.name);
      return;
    }
    const header = target.closest('.category-box header');
    const category = (header?.parentElement as HTMLElement | null)?.dataset.category as WorkspaceCategory | undefined;
    if (category !== hoveredCategory) {
      hoveredCategory = category;
      draw();
    }
  });
  svgElement.addEventListener('mouseout', (event) => {
    const from = (event.target as HTMLElement).closest('.member');
    const to = (event.relatedTarget as HTMLElement | null)?.closest('.member');
    if (from !== null && from !== to) context.focus.leave();
    const leftHeader = (event.target as HTMLElement).closest('.category-box header');
    const enteredHeader = (event.relatedTarget as HTMLElement | null)?.closest('.category-box header');
    if (leftHeader !== null && leftHeader !== enteredHeader) {
      hoveredCategory = undefined;
      draw();
    }
  });
  svgElement.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>('[data-action="toggle"]');
    if (toggle !== null) {
      const section = toggle.closest<HTMLElement>('.category-box') as HTMLElement;
      setCollapsed(section, !section.classList.contains('collapsed'));
      measure();
      draw();
      return;
    }
    const chip = target.closest<HTMLElement>('.member');
    if (chip?.dataset.name !== undefined) {
      context.focus.toggle(chip.dataset.name);
    } else if (target.closest('.category-node') === null) {
      context.focus.clear();
    }
  });

  const setAll = (collapsed: boolean) => {
    sections.forEach((section) => setCollapsed(section, collapsed));
    measure();
    draw();
  };
  controls.querySelector('[data-action="fit"]')?.addEventListener('click', fit);
  controls.querySelector('[data-action="expand-all"]')?.addEventListener('click', () => setAll(false));
  controls.querySelector('[data-action="collapse-all"]')?.addEventListener('click', () => setAll(true));
  controls.querySelector('[data-action="reset-layout"]')?.addEventListener('click', () => {
    for (const category of categories) {
      positions.set(category, { ...(defaultPositions.get(category) as Position) });
    }
    savePositions(POSITIONS_STORAGE_KEY, new Map());
    placeBoxes();
    draw();
    fit();
  });

  context.focus.subscribe((focus, query) => {
    currentFocus = focus;
    for (const [category, section] of sections) {
      section.classList.toggle(
        'involved',
        focus !== undefined &&
          membersOf(category).some(
            (member) => member.name === focus.name || focus.dependencies.has(member.name) || focus.dependents.has(member.name),
          ),
      );
      for (const chip of section.querySelectorAll<HTMLElement>('.member')) {
        const name = chip.dataset.name as string;
        const node = context.nodeByName.get(name) as WorkspaceNode;
        chip.classList.toggle('active', focus?.name === name);
        chip.classList.toggle('dependency', focus?.dependencies.has(name) ?? false);
        chip.classList.toggle('dependent', focus?.dependents.has(name) ?? false);
        chip.classList.toggle('match', query.length > 0 && node.label.toLowerCase().includes(query));
      }
    }
    draw();
  });

  let lastWidth = 0;
  new ResizeObserver(() => {
    if (svgElement.clientWidth === lastWidth) return;
    lastWidth = svgElement.clientWidth;
    fit();
  }).observe(svgElement);

  fit();
}
