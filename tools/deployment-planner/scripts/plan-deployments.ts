import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { planDeployments } from './deployment-plan.ts';
import { DEPLOYMENT_TARGETS } from './deployment-targets.ts';
import { collectWorkspaces } from './workspaces.ts';

/**
 * Plans the deployments for a commit range. It only reads the repository and
 * reports the plan; running the deploy workflows is up to the caller.
 *
 * Environment:
 * - `BASE_SHA`: commit before the change. Empty or all zeros means the parent of `HEAD_SHA`.
 * - `HEAD_SHA`: commit after the change, `HEAD` by default.
 *
 * Writes the outputs to `GITHUB_OUTPUT` when it is set, and prints them as JSON either way.
 */

const git = (...arguments_: string[]) => execFileSync('git', arguments_, { encoding: 'utf8' }).trim();

const head = process.env.HEAD_SHA === undefined || process.env.HEAD_SHA === '' ? 'HEAD' : process.env.HEAD_SHA;
const givenBase = process.env.BASE_SHA ?? '';
const base = givenBase === '' || /^0+$/.test(givenBase) ? `${head}^` : givenBase;

const root = git('rev-parse', '--show-toplevel');
// Without rename detection a moved file shows up at both paths, so the old owner counts too.
const changedFiles = git('-C', root, 'diff', '--name-only', '--no-renames', base, head)
  .split('\n')
  .filter((file) => file !== '');

const plan = planDeployments(changedFiles, collectWorkspaces(root), DEPLOYMENT_TARGETS);

const outputs: Record<string, string> = {
  deployments: JSON.stringify(plan.dispatches),
  'has-deployments': String(plan.dispatches.length > 0),
  'changed-workspaces': JSON.stringify(plan.changedWorkspaces),
  'affected-workspaces': JSON.stringify(plan.affectedWorkspaces),
  'paused-workspaces': JSON.stringify(plan.paused),
  'repository-changes': JSON.stringify(plan.repositoryChanges),
};

if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
}

console.log(JSON.stringify({ base, head, ...plan }, null, 2));
