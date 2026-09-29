import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Workspace {
  name: string;
  /** Directory relative to the repository root, e.g. `workers/google-oauth-provider-worker`. */
  path: string;
  /** Other workspaces this one depends on, in any dependency field. */
  dependencies: string[];
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The `packages:` globs of `pnpm-workspace.yaml`, as their parent directories (`workers/*` → `workers`). */
export function readWorkspaceDirectories(workspaceFile: string): string[] {
  const directories: string[] = [];
  let insidePackages = false;

  for (const line of workspaceFile.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      insidePackages = true;
      continue;
    }
    if (!insidePackages) {
      continue;
    }
    if (/^\S/.test(line)) {
      break;
    }
    const match = /^\s*-\s*['"]?([^'"\s]+?)\/\*['"]?\s*$/.exec(line);
    if (match) {
      directories.push(match[1]);
    }
  }

  return directories;
}

/** Every workspace under the repository root, with dependencies narrowed to other workspaces. */
export function collectWorkspaces(rootPath: string): Workspace[] {
  const manifests: { path: string; manifest: PackageManifest }[] = [];
  const workspaceFile = readFileSync(join(rootPath, 'pnpm-workspace.yaml'), 'utf8');

  for (const directory of readWorkspaceDirectories(workspaceFile)) {
    const directoryPath = join(rootPath, directory);
    if (!existsSync(directoryPath)) {
      continue;
    }
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const manifestPath = join(directoryPath, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(manifestPath)) {
        manifests.push({ path: `${directory}/${entry.name}`, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) });
      }
    }
  }

  const names = new Set(manifests.flatMap(({ manifest }) => (manifest.name === undefined ? [] : [manifest.name])));

  return manifests
    .filter(({ manifest }) => manifest.name !== undefined)
    .map(({ path, manifest }) => ({
      name: manifest.name as string,
      path,
      dependencies: [
        ...new Set(
          [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
            .flatMap((field) => Object.keys(field ?? {}))
            .filter((dependency) => names.has(dependency)),
        ),
      ].sort(),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
