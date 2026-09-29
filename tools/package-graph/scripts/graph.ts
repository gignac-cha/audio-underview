export interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * - `library`: shared package bundled into whatever depends on it
 * - `tools`: shared helper package of one runtime (`workers/tools`, `functions/tools`)
 * - `worker` / `pages` / `lambda`: deployable, by where it ships
 * - `developer-tool`: local tooling under `tools/`, never deployed
 */
export type WorkspaceKind = 'library' | 'tools' | 'worker' | 'pages' | 'lambda' | 'developer-tool';

/** Role-based groups the category view draws as boxes. */
export type WorkspaceCategory =
  | 'core'
  | 'provider-packages'
  | 'runtime-tools'
  | 'oauth-workers'
  | 'platform-workers'
  | 'web'
  | 'functions'
  | 'developer-tools';

export interface CategoryDefinition {
  id: WorkspaceCategory;
  label: string;
  description: string;
  /** Common name ending the view may drop inside the box (`-oauth-provider-worker`). */
  suffix?: string;
}

export const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  { id: 'core', label: '핵심 라이브러리', description: '로그, 인증 타입, DB 연결처럼 거의 모든 패키지가 쓰는 기반입니다.' },
  { id: 'provider-packages', label: 'OAuth provider 패키지', description: 'provider마다 엔드포인트와 사용자 정보 해석을 담습니다.', suffix: '-oauth-provider' },
  { id: 'runtime-tools', label: '런타임 도구', description: '워커와 함수가 함께 쓰는 헬퍼입니다.' },
  { id: 'oauth-workers', label: 'OAuth 워커', description: 'provider마다 하나씩 있는 로그인 워커로, Cloudflare Workers에 배포합니다.', suffix: '-oauth-provider-worker' },
  { id: 'platform-workers', label: '플랫폼 워커', description: '크롤러와 스케줄러 워커로, Cloudflare Workers에 배포합니다.', suffix: '-worker' },
  { id: 'web', label: '웹 애플리케이션', description: 'Cloudflare Pages에 배포합니다.' },
  { id: 'functions', label: '서버리스 함수', description: 'AWS Lambda에 배포합니다.' },
  { id: 'developer-tools', label: '개발 도구', description: '로컬에서만 쓰고 배포하지 않습니다.' },
];

export interface WorkspaceNode {
  name: string;
  label: string;
  path: string;
  kind: WorkspaceKind;
  category: WorkspaceCategory;
  depth: number;
}

/** `source` depends on `target`. */
export interface WorkspaceEdge {
  source: string;
  target: string;
  development: boolean;
}

export interface WorkspaceGraph {
  categories: CategoryDefinition[];
  nodes: WorkspaceNode[];
  edges: WorkspaceEdge[];
}

/** Dependencies between two categories, folded into one line. */
export interface CategoryEdge {
  source: WorkspaceCategory;
  target: WorkspaceCategory;
  edges: WorkspaceEdge[];
}

const SCOPE_PREFIX = '@audio-underview/';
const WORKSPACE_PATH_PATTERN = /(?:^|\/)([^/]+\/[^/]+)\/package\.json$/;

/** Turns `workers/github-oauth-provider-worker/package.json` into `workers/github-oauth-provider-worker`. */
export function toWorkspacePath(manifestPath: string): string | undefined {
  return WORKSPACE_PATH_PATTERN.exec(manifestPath)?.[1];
}

/**
 * Decides what a workspace ships as. Only the directory and the scripts are
 * consulted, so the answer follows the repository layout rather than a list.
 */
export function classifyWorkspace(path: string, manifest: PackageManifest): WorkspaceKind {
  const [directory, name] = path.split('/');
  const scripts = manifest.scripts ?? {};

  if (directory === 'tools') {
    return 'developer-tool';
  }
  if (name === 'tools') {
    return 'tools';
  }
  if (directory === 'applications') {
    return 'pages';
  }
  if (directory === 'workers' && scripts.deploy !== undefined) {
    return 'worker';
  }
  if (directory === 'functions' && scripts.build !== undefined) {
    return 'lambda';
  }
  return 'library';
}

/** Groups a workspace by role. Only the path and the kind are consulted. */
export function categorizeWorkspace(path: string, kind: WorkspaceKind): WorkspaceCategory {
  const name = path.split('/')[1] ?? '';

  switch (kind) {
    case 'developer-tool':
      return 'developer-tools';
    case 'tools':
      return 'runtime-tools';
    case 'pages':
      return 'web';
    case 'lambda':
      return 'functions';
    case 'worker':
      return name.endsWith('-oauth-provider-worker') ? 'oauth-workers' : 'platform-workers';
    case 'library':
      return name.endsWith('-oauth-provider') ? 'provider-packages' : 'core';
  }
}

/**
 * Builds the workspace dependency graph from package manifests keyed by manifest path.
 * Only dependencies on other workspaces become edges. A dependency listed in both
 * `dependencies` and `devDependencies` is kept once, as a production edge.
 * Nodes are sorted by path and edges by source then target, so the output is stable.
 */
export function buildWorkspaceGraph(manifests: Record<string, PackageManifest>): WorkspaceGraph {
  const entries: { name: string; path: string; manifest: PackageManifest }[] = [];

  for (const [manifestPath, manifest] of Object.entries(manifests)) {
    const path = toWorkspacePath(manifestPath);
    if (path === undefined || manifest.name === undefined) {
      continue;
    }
    entries.push({ name: manifest.name, path, manifest });
  }

  const names = new Set(entries.map((entry) => entry.name));
  const edges: WorkspaceEdge[] = [];

  for (const { name, manifest } of entries) {
    const production = Object.keys(manifest.dependencies ?? {}).filter((dependency) => names.has(dependency));
    const development = Object.keys(manifest.devDependencies ?? {}).filter(
      (dependency) => names.has(dependency) && !production.includes(dependency),
    );

    for (const dependency of production) {
      edges.push({ source: name, target: dependency, development: false });
    }
    for (const dependency of development) {
      edges.push({ source: name, target: dependency, development: true });
    }
  }

  edges.sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));

  const depths = computeDepths([...names], edges);

  const nodes = entries
    .map(({ name, path, manifest }) => {
      const kind = classifyWorkspace(path, manifest);
      return {
        name,
        label: name.startsWith(SCOPE_PREFIX) ? name.slice(SCOPE_PREFIX.length) : name,
        path,
        kind,
        category: categorizeWorkspace(path, kind),
        depth: depths.get(name) ?? 0,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const usedCategories = new Set(nodes.map((node) => node.category));
  const categories = CATEGORY_DEFINITIONS.filter((category) => usedCategories.has(category.id));

  return { categories, nodes, edges };
}

/**
 * Folds workspace edges into one edge per ordered pair of categories.
 * Edges inside a single category are left out — the box already groups them.
 */
export function aggregateCategoryEdges(nodes: WorkspaceNode[], edges: WorkspaceEdge[]): CategoryEdge[] {
  const categoryOf = new Map(nodes.map((node) => [node.name, node.category]));
  const byPair = new Map<string, CategoryEdge>();

  for (const edge of edges) {
    const source = categoryOf.get(edge.source);
    const target = categoryOf.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const key = `${source}>${target}`;
    const existing = byPair.get(key) ?? { source, target, edges: [] };
    existing.edges.push(edge);
    byPair.set(key, existing);
  }

  return [...byPair.values()].sort((left, right) => right.edges.length - left.edges.length);
}

/** Layer of each category: 0 for categories that depend on no other category. */
export function computeCategoryLayers(categories: WorkspaceCategory[], categoryEdges: CategoryEdge[]): Map<WorkspaceCategory, number> {
  const depths = computeDepths(
    categories,
    categoryEdges.map((edge) => ({ source: edge.source, target: edge.target, development: false })),
  );
  return new Map(categories.map((category) => [category, depths.get(category) ?? 0]));
}

/**
 * Depth is the length of the longest dependency chain below a workspace:
 * workspaces with no workspace dependencies sit at 0. A cycle is cut where it closes.
 */
export function computeDepths(names: string[], edges: WorkspaceEdge[]): Map<string, number> {
  const dependenciesByName = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependenciesByName.get(edge.source) ?? [];
    list.push(edge.target);
    dependenciesByName.set(edge.source, list);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  const visit = (name: string): number => {
    const known = depths.get(name);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(name)) {
      return 0;
    }
    visiting.add(name);
    const dependencies = dependenciesByName.get(name) ?? [];
    const depth = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(visit));
    visiting.delete(name);
    depths.set(name, depth);
    return depth;
  };

  for (const name of names) {
    visit(name);
  }
  return depths;
}

/**
 * Drops every edge whose target is still reachable from its source through
 * another path. Reachability is unchanged; only the shortcuts go.
 */
export function reduceTransitively(edges: WorkspaceEdge[]): WorkspaceEdge[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  const reachableAnotherWay = (source: string, target: string) => {
    const stack = (adjacency.get(source) ?? []).filter((next) => next !== target);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === target) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }
    return false;
  };

  return edges.filter((edge) => !reachableAnotherWay(edge.source, edge.target));
}

/** Every workspace reachable by following edges from `start` in the given direction. */
export function collectReachable(
  start: string,
  edges: WorkspaceEdge[],
  direction: 'dependencies' | 'dependents',
): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] = direction === 'dependencies' ? [edge.source, edge.target] : [edge.target, edge.source];
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  }

  const reached = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (!reached.has(next) && next !== start) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}
