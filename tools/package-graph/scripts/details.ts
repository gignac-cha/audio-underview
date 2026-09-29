import type { WorkspaceNode } from './graph.ts';
import { escapeHTML, type GraphContext } from './context.ts';

/**
 * One sentence on the pinned package's reach. Indirect totals are only
 * mentioned where they add something to the direct counts.
 */
export function describe(directUses: number, allUses: number, directUsedBy: number, allUsedBy: number): string {
  const strong = (value: number) => `<strong>${value}</strong>`;
  const uses =
    allUses === 0
      ? '다른 패키지를 쓰지 않고'
      : allUses === directUses
        ? `패키지 ${strong(directUses)}개를 쓰고`
        : `패키지 ${strong(directUses)}개를 직접 쓰며 거쳐서 쓰는 것까지 ${strong(allUses)}개이고`;
  const usedBy =
    allUsedBy === 0
      ? '이 패키지를 쓰는 곳은 없습니다.'
      : allUsedBy === directUsedBy
        ? `${strong(directUsedBy)}곳에서 쓰입니다.`
        : `${strong(directUsedBy)}곳에서 직접 쓰이며 거쳐서 쓰이는 곳까지 ${strong(allUsedBy)}곳입니다.`;
  return `${uses}, ${usedBy}`;
}

/**
 * Side panel for the pinned package: what it uses and what uses it. Direct
 * relationships are listed; the counts include indirect ones too.
 */
export function mountDetails(element: HTMLElement, context: GraphContext) {
  const lookUp = (name: string) => context.nodeByName.get(name) as WorkspaceNode;
  const categoryLabel = (node: WorkspaceNode) =>
    context.graph.categories.find((category) => category.id === node.category)?.label ?? node.category;

  const chips = (names: string[]) =>
    names
      .map(lookUp)
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(
        (member) =>
          `<li><button type="button" data-category="${member.category}" data-name="${escapeHTML(member.name)}">${escapeHTML(member.label)}</button></li>`,
      )
      .join('') || '<li class="empty">없음</li>';

  element.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.closest('[data-action="close"]')) {
      context.focus.clear();
      return;
    }
    const chip = target.closest<HTMLElement>('[data-name]');
    if (chip?.dataset.name !== undefined) {
      context.focus.pin(chip.dataset.name);
    }
  });

  // The panel column is always there, so nothing ever changes the page width.
  let shown: string | null = null;

  context.focus.subscribe((_highlight, _query, focus) => {
    // Hover changes the highlight many times a second; the panel only changes
    // when the pinned package does.
    if ((focus?.name ?? '') === shown) {
      return;
    }
    shown = focus?.name ?? '';

    if (focus === undefined) {
      element.innerHTML = `
        <div class="details-empty">
          <h2>선택한 패키지가 없습니다</h2>
          <p>패키지를 누르면 그 패키지가 쓰는 패키지와 그 패키지를 쓰는 패키지가 여기에 나옵니다.</p>
        </div>
      `;
      return;
    }

    const node = lookUp(focus.name);
    const uses = context.graph.edges.filter((edge) => edge.source === focus.name).map((edge) => edge.target);
    const usedBy = context.graph.edges.filter((edge) => edge.target === focus.name).map((edge) => edge.source);

    element.innerHTML = `
      <div class="details-header">
        <span class="category" data-category="${node.category}">${escapeHTML(categoryLabel(node))}</span>
        <button type="button" class="close" data-action="close" aria-label="선택 해제">×</button>
      </div>
      <h2>${escapeHTML(node.label)}</h2>
      <p class="path">${escapeHTML(node.path)}</p>
      <p class="summary">${describe(uses.length, focus.dependencies.size, usedBy.length, focus.dependents.size)}</p>
      <h3>이 패키지가 쓰는 패키지</h3>
      <ul class="chips">${chips(uses)}</ul>
      <h3>이 패키지를 쓰는 패키지</h3>
      <ul class="chips">${chips(usedBy)}</ul>
    `;
  });
}
