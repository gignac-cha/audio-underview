import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_TARGETS } from './deployment-targets.ts';
import { collectWorkspaces } from './workspaces.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const workflow = (file: string) => readFileSync(join(root, '.github/workflows', file), 'utf8');

describe('DEPLOYMENT_TARGETS', () => {
  it('names only workspaces that exist', () => {
    const names = new Set(collectWorkspaces(root).map((workspace) => workspace.name));
    expect([...DEPLOYMENT_TARGETS.keys()].filter((name) => !names.has(name))).toEqual([]);
  });

  it('covers every worker, function and application that has a deploy workflow', () => {
    const deployable = collectWorkspaces(root)
      .filter((workspace) => /^(workers|functions|applications)\//.test(workspace.path))
      .filter((workspace) => !workspace.path.endsWith('/tools'))
      .map((workspace) => workspace.name);
    expect(deployable.filter((name) => !DEPLOYMENT_TARGETS.has(name))).toEqual([]);
  });

  it('points at workflows that can be dispatched with the inputs it sets', () => {
    for (const [name, target] of DEPLOYMENT_TARGETS) {
      const source = workflow(target.workflow);
      expect(source, `${target.workflow} for ${name}`).toMatch(/^\s+workflow_dispatch:/m);
      if (target.input !== undefined) {
        expect(source, `${target.workflow} input ${target.input}`).toMatch(new RegExp(`^      ${target.input}:$`, 'm'));
      }
    }
  });
});
