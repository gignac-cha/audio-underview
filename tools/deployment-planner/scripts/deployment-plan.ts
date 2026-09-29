import type { DeploymentTarget } from './deployment-targets.ts';
import type { Workspace } from './workspaces.ts';

/** One run of a deploy workflow, with the boolean inputs to switch on. */
export interface WorkflowDispatch {
  workflow: string;
  inputs: string[];
  workspaces: string[];
}

export interface PausedDeployment {
  workspace: string;
  reason: string;
}

export interface DeploymentPlan {
  /** Repository-level files that made every workspace count as changed. */
  repositoryChanges: string[];
  /** Workspaces whose own files changed. */
  changedWorkspaces: string[];
  /** Changed workspaces plus everything that depends on them, directly or not. */
  affectedWorkspaces: string[];
  dispatches: WorkflowDispatch[];
  paused: PausedDeployment[];
}

/** Changing one of these can change how any workspace builds. */
const REPOSITORY_FILES = new Set(['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'tsconfig.json']);
const LOCKFILE = 'pnpm-lock.yaml';

/**
 * Files that never reach a deployed bundle. Migrations are applied by their
 * own workflow, so a migration alone must not redeploy the connector's users.
 */
export function isIgnored(file: string): boolean {
  const segments = file.split('/');
  const base = segments[segments.length - 1];
  return (
    base.endsWith('.md') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /^vitest\.config\.[cm]?[jt]s$/.test(base) ||
    segments.slice(0, -1).some((segment) => segment === 'tests' || segment === '__tests__' || segment === 'migrations')
  );
}

/** The workspace a file belongs to, by the longest directory prefix. */
function owningWorkspace(file: string, workspaces: Workspace[]): Workspace | undefined {
  let owner: Workspace | undefined;
  for (const workspace of workspaces) {
    if (file.startsWith(`${workspace.path}/`) && (owner === undefined || workspace.path.length > owner.path.length)) {
      owner = workspace;
    }
  }
  return owner;
}

/** `names` plus every workspace that reaches one of them through its dependencies. */
function withDependents(names: Set<string>, workspaces: Workspace[]): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const workspace of workspaces) {
    for (const dependency of workspace.dependencies) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), workspace.name]);
    }
  }

  const reached = new Set(names);
  const queue = [...names];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift() as string) ?? []) {
      if (!reached.has(dependent)) {
        reached.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return reached;
}

export function planDeployments(changedFiles: string[], workspaces: Workspace[], targets: ReadonlyMap<string, DeploymentTarget>): DeploymentPlan {
  const files = changedFiles.filter((file) => !isIgnored(file));
  const changed = new Set<string>();
  const repositoryChanges = files.filter((file) => REPOSITORY_FILES.has(file));
  let manifestChanged = false;

  for (const file of files) {
    const owner = owningWorkspace(file, workspaces);
    if (owner !== undefined) {
      changed.add(owner.name);
      manifestChanged ||= file === `${owner.path}/package.json`;
    }
  }

  // A lockfile change that comes with a workspace manifest change belongs to that
  // workspace. On its own it is a dependency refresh that can touch anything.
  if (files.includes(LOCKFILE) && !manifestChanged) {
    repositoryChanges.push(LOCKFILE);
  }

  const affected = repositoryChanges.length > 0 ? new Set(workspaces.map((workspace) => workspace.name)) : withDependents(changed, workspaces);

  const dispatches = new Map<string, WorkflowDispatch>();
  const paused: PausedDeployment[] = [];

  for (const name of [...affected].sort()) {
    const target = targets.get(name);
    if (target === undefined) {
      continue;
    }
    if (target.paused !== undefined) {
      paused.push({ workspace: name, reason: target.paused });
      continue;
    }
    const dispatch = dispatches.get(target.workflow) ?? { workflow: target.workflow, inputs: [], workspaces: [] };
    if (target.input !== undefined) {
      dispatch.inputs.push(target.input);
    }
    dispatch.workspaces.push(name);
    dispatches.set(target.workflow, dispatch);
  }

  return {
    repositoryChanges,
    changedWorkspaces: [...changed].sort(),
    affectedWorkspaces: [...affected].sort(),
    dispatches: [...dispatches.values()].sort((left, right) => left.workflow.localeCompare(right.workflow)),
    paused,
  };
}
