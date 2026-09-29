import { describe, expect, it } from 'vitest';
import {
  aggregateCategoryEdges,
  buildWorkspaceGraph,
  categorizeWorkspace,
  classifyWorkspace,
  computeCategoryLayers,
  collectReachable,
  computeDepths,
  reduceTransitively,
  toWorkspacePath,
  type PackageManifest,
  type WorkspaceEdge,
} from './graph.ts';

const manifests: Record<string, PackageManifest> = {
  'packages/logger/package.json': { name: '@audio-underview/logger' },
  'packages/sign-provider/package.json': {
    name: '@audio-underview/sign-provider',
    dependencies: { zod: '^4.0.0' },
  },
  'workers/tools/package.json': {
    name: '@audio-underview/worker-tools',
    dependencies: { '@audio-underview/logger': 'workspace:*', '@audio-underview/sign-provider': 'workspace:*' },
  },
  'workers/github-oauth-provider-worker/package.json': {
    name: '@audio-underview/github-oauth-provider-worker',
    scripts: { deploy: 'wrangler deploy' },
    dependencies: { '@audio-underview/worker-tools': 'workspace:*' },
    devDependencies: { '@audio-underview/logger': 'workspace:*', '@audio-underview/worker-tools': 'workspace:*' },
  },
  'applications/web/package.json': {
    name: '@audio-underview/web',
    dependencies: { '@audio-underview/sign-provider': 'workspace:*' },
  },
  'functions/crawler-code-runner-function/package.json': {
    name: '@audio-underview/crawler-code-runner-function',
    scripts: { build: 'node build.ts' },
  },
  'functions/tools/package.json': { name: '@audio-underview/function-tools' },
  'tools/environment-generator/package.json': { name: '@audio-underview/environment-generator' },
};

describe('toWorkspacePath', () => {
  it('extracts the workspace directory from a manifest path', () => {
    expect(toWorkspacePath('workers/github-oauth-provider-worker/package.json')).toBe('workers/github-oauth-provider-worker');
  });

  it('rejects a path that is not a package manifest', () => {
    expect(toWorkspacePath('workers/github-oauth-provider-worker/wrangler.toml')).toBeUndefined();
  });
});

describe('classifyWorkspace', () => {
  it('classifies each directory by what it ships as', () => {
    expect(classifyWorkspace('applications/web', {})).toBe('pages');
    expect(classifyWorkspace('workers/github-oauth-provider-worker', { scripts: { deploy: 'wrangler deploy' } })).toBe('worker');
    expect(classifyWorkspace('functions/crawler-code-runner-function', { scripts: { build: 'node build.ts' } })).toBe('lambda');
    expect(classifyWorkspace('packages/logger', {})).toBe('library');
  });

  it('separates the runtime tools packages from libraries', () => {
    expect(classifyWorkspace('workers/tools', {})).toBe('tools');
    expect(classifyWorkspace('functions/tools', {})).toBe('tools');
  });

  it('separates local developer tooling from the runtime tools packages', () => {
    expect(classifyWorkspace('tools/environment-generator', {})).toBe('developer-tool');
    expect(classifyWorkspace('tools/package-graph', { scripts: { build: 'vite build' } })).toBe('developer-tool');
  });
});

describe('categorizeWorkspace', () => {
  it('groups each workspace by role', () => {
    expect(categorizeWorkspace('packages/logger', 'library')).toBe('core');
    expect(categorizeWorkspace('packages/github-oauth-provider', 'library')).toBe('provider-packages');
    expect(categorizeWorkspace('workers/tools', 'tools')).toBe('runtime-tools');
    expect(categorizeWorkspace('workers/github-oauth-provider-worker', 'worker')).toBe('oauth-workers');
    expect(categorizeWorkspace('workers/crawler-manager-worker', 'worker')).toBe('platform-workers');
    expect(categorizeWorkspace('applications/web', 'pages')).toBe('web');
    expect(categorizeWorkspace('functions/crawler-code-runner-function', 'lambda')).toBe('functions');
    expect(categorizeWorkspace('tools/package-graph', 'developer-tool')).toBe('developer-tools');
  });
});

describe('aggregateCategoryEdges', () => {
  const graph = buildWorkspaceGraph(manifests);
  const categoryEdges = aggregateCategoryEdges(graph.nodes, graph.edges);

  it('folds workspace edges into one edge per category pair', () => {
    const workersToTools = categoryEdges.find((edge) => edge.source === 'oauth-workers' && edge.target === 'runtime-tools');
    expect(workersToTools?.edges).toHaveLength(1);
  });

  it('leaves out edges inside one category', () => {
    expect(categoryEdges.some((edge) => edge.source === edge.target)).toBe(false);
    // logger and sign-provider are both core; worker-tools → logger crosses categories.
    expect(categoryEdges.find((edge) => edge.source === 'runtime-tools' && edge.target === 'core')?.edges).toHaveLength(2);
  });

  it('layers categories by the longest category chain', () => {
    const layers = computeCategoryLayers(
      graph.categories.map((category) => category.id),
      categoryEdges,
    );
    expect(layers.get('core')).toBe(0);
    expect(layers.get('runtime-tools')).toBe(1);
    expect(layers.get('oauth-workers')).toBe(2);
    expect(layers.get('developer-tools')).toBe(0);
  });
});

describe('buildWorkspaceGraph', () => {
  const graph = buildWorkspaceGraph(manifests);

  it('lists only the categories that have members, in definition order', () => {
    expect(graph.categories.map((category) => category.id)).toEqual([
      'core',
      'runtime-tools',
      'oauth-workers',
      'web',
      'functions',
      'developer-tools',
    ]);
  });

  it('creates one node per workspace with the scope removed from the label', () => {
    expect(graph.nodes).toHaveLength(8);
    expect(graph.nodes.find((node) => node.name === '@audio-underview/worker-tools')?.label).toBe('worker-tools');
  });

  it('keeps only edges between workspaces', () => {
    expect(graph.edges.some((edge) => edge.target === 'zod')).toBe(false);
  });

  it('keeps a dependency listed twice once, as a production edge', () => {
    const toWorkerTools = graph.edges.filter(
      (edge) => edge.source === '@audio-underview/github-oauth-provider-worker' && edge.target === '@audio-underview/worker-tools',
    );
    expect(toWorkerTools).toEqual([
      { source: '@audio-underview/github-oauth-provider-worker', target: '@audio-underview/worker-tools', development: false },
    ]);
  });

  it('marks development-only dependencies', () => {
    expect(graph.edges).toContainEqual({
      source: '@audio-underview/github-oauth-provider-worker',
      target: '@audio-underview/logger',
      development: true,
    });
  });

  it('assigns the longest dependency chain as depth', () => {
    const depthOf = (name: string) => graph.nodes.find((node) => node.name === name)?.depth;
    expect(depthOf('@audio-underview/logger')).toBe(0);
    expect(depthOf('@audio-underview/worker-tools')).toBe(1);
    expect(depthOf('@audio-underview/github-oauth-provider-worker')).toBe(2);
    expect(depthOf('@audio-underview/web')).toBe(1);
  });

  it('orders nodes and edges the same way regardless of input order', () => {
    const reversed = Object.fromEntries(Object.entries(manifests).reverse());
    expect(buildWorkspaceGraph(reversed)).toEqual(graph);
  });
});

describe('computeDepths', () => {
  it('terminates on a cycle', () => {
    const depths = computeDepths(
      ['a', 'b'],
      [
        { source: 'a', target: 'b', development: false },
        { source: 'b', target: 'a', development: false },
      ],
    );
    expect(depths.size).toBe(2);
  });
});

describe('reduceTransitively', () => {
  const edge = (source: string, target: string): WorkspaceEdge => ({ source, target, development: false });

  it('drops an edge that another path already covers', () => {
    expect(reduceTransitively([edge('a', 'b'), edge('b', 'c'), edge('a', 'c')])).toEqual([edge('a', 'b'), edge('b', 'c')]);
  });

  it('keeps reachability unchanged', () => {
    const { edges } = buildWorkspaceGraph(manifests);
    const reduced = reduceTransitively(edges);
    for (const node of buildWorkspaceGraph(manifests).nodes) {
      expect(collectReachable(node.name, reduced, 'dependents')).toEqual(collectReachable(node.name, edges, 'dependents'));
    }
  });
});


describe('collectReachable', () => {
  const { edges } = buildWorkspaceGraph(manifests);

  it('collects every workspace that transitively depends on a library', () => {
    expect(collectReachable('@audio-underview/sign-provider', edges, 'dependents')).toEqual(
      new Set(['@audio-underview/worker-tools', '@audio-underview/github-oauth-provider-worker', '@audio-underview/web']),
    );
  });

  it('collects every workspace a deployable transitively depends on', () => {
    expect(collectReachable('@audio-underview/github-oauth-provider-worker', edges, 'dependencies')).toEqual(
      new Set(['@audio-underview/worker-tools', '@audio-underview/logger', '@audio-underview/sign-provider']),
    );
  });
});
