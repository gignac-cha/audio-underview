import { describe, expect, it } from 'vitest';
import { isIgnored, planDeployments } from './deployment-plan.ts';
import type { DeploymentTarget } from './deployment-targets.ts';
import type { Workspace } from './workspaces.ts';

const workspaces: Workspace[] = [
  { name: 'logger', path: 'packages/logger', dependencies: [] },
  { name: 'connector', path: 'packages/connector', dependencies: ['logger'] },
  { name: 'google-provider', path: 'packages/google-provider', dependencies: [] },
  { name: 'worker-tools', path: 'workers/tools', dependencies: ['logger'] },
  { name: 'google-worker', path: 'workers/google-worker', dependencies: ['google-provider', 'worker-tools', 'connector'] },
  { name: 'github-worker', path: 'workers/github-worker', dependencies: ['worker-tools'] },
  { name: 'new-worker', path: 'workers/new-worker', dependencies: ['worker-tools'] },
  { name: 'scheduler', path: 'workers/scheduler', dependencies: ['connector'] },
  { name: 'web', path: 'applications/web', dependencies: ['google-provider'] },
  { name: 'graph-tool', path: 'tools/graph-tool', dependencies: [] },
];

const targets = new Map<string, DeploymentTarget>([
  ['google-worker', { workflow: 'deploy-oauth.yml', input: 'google' }],
  ['github-worker', { workflow: 'deploy-oauth.yml', input: 'github' }],
  ['new-worker', { workflow: 'deploy-oauth.yml', input: 'new', paused: 'waits for secrets' }],
  ['scheduler', { workflow: 'deploy-scheduler.yml' }],
  ['web', { workflow: 'deploy-web.yml' }],
]);

const plan = (...files: string[]) => planDeployments(files, workspaces, targets);

describe('planDeployments', () => {
  it('deploys a changed worker alone', () => {
    expect(plan('workers/github-worker/sources/index.ts').dispatches).toEqual([
      { workflow: 'deploy-oauth.yml', inputs: ['github'], workspaces: ['github-worker'] },
    ]);
  });

  it('follows dependents through libraries, grouping inputs by workflow', () => {
    const result = plan('packages/logger/sources/logger.ts');
    expect(result.changedWorkspaces).toEqual(['logger']);
    expect(result.dispatches).toEqual([
      { workflow: 'deploy-oauth.yml', inputs: ['github', 'google'], workspaces: ['github-worker', 'google-worker'] },
      { workflow: 'deploy-scheduler.yml', inputs: [], workspaces: ['scheduler'] },
    ]);
  });

  it('reports paused targets instead of dispatching them', () => {
    const result = plan('workers/tools/sources/response.ts');
    expect(result.paused).toEqual([{ workspace: 'new-worker', reason: 'waits for secrets' }]);
    expect(result.dispatches.flatMap((dispatch) => dispatch.inputs)).not.toContain('new');
  });

  it('deploys nothing for tests, documents, migrations or files outside workspaces', () => {
    const result = plan(
      'packages/connector/migrations/009_add_providers.sql',
      'workers/google-worker/tests/handler.test.ts',
      'workers/google-worker/sources/handler.test.ts',
      'workers/google-worker/vitest.config.ts',
      'packages/logger/README.md',
      'documents/2026-09-29-plan.md',
      '.github/workflows/deploy-web.yml',
    );
    expect(result.changedWorkspaces).toEqual([]);
    expect(result.dispatches).toEqual([]);
  });

  it('ignores changes to workspaces nothing deploys', () => {
    expect(plan('tools/graph-tool/script.ts').dispatches).toEqual([]);
  });

  it('treats repository-level files as touching every workspace', () => {
    const result = plan('turbo.json');
    expect(result.repositoryChanges).toEqual(['turbo.json']);
    expect(result.affectedWorkspaces).toHaveLength(workspaces.length);
    expect(result.dispatches.map((dispatch) => dispatch.workflow)).toEqual(['deploy-oauth.yml', 'deploy-scheduler.yml', 'deploy-web.yml']);
  });

  it('treats a lockfile change on its own as touching every workspace', () => {
    expect(plan('pnpm-lock.yaml').repositoryChanges).toEqual(['pnpm-lock.yaml']);
  });

  it('attributes a lockfile change to the workspace whose manifest changed with it', () => {
    const result = plan('pnpm-lock.yaml', 'tools/graph-tool/package.json');
    expect(result.repositoryChanges).toEqual([]);
    expect(result.dispatches).toEqual([]);
  });

  it('counts a root manifest change but not a workspace one as repository-wide', () => {
    expect(plan('package.json').repositoryChanges).toEqual(['package.json']);
    expect(plan('workers/github-worker/package.json').repositoryChanges).toEqual([]);
  });
});

describe('isIgnored', () => {
  it('keeps source and configuration files', () => {
    expect(isIgnored('workers/google-worker/sources/index.ts')).toBe(false);
    expect(isIgnored('workers/google-worker/wrangler.toml')).toBe(false);
    expect(isIgnored('packages/connector/sources/migrations.ts')).toBe(false);
  });
});
