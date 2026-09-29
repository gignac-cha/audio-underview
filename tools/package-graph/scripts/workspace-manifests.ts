import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageManifest } from './graph.ts';

/**
 * Reads the workspace directories from `pnpm-workspace.yaml`, the single place
 * the repository declares them (`packages/*`, `workers/*`, …).
 */
export function readWorkspaceDirectories(rootPath: string): string[] {
  const lines = readFileSync(join(rootPath, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const directories: string[] = [];
  let insidePackages = false;

  for (const line of lines) {
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

/** Every workspace `package.json`, keyed by its path relative to the repository root. */
export function collectWorkspaceManifests(rootPath: string): Record<string, PackageManifest> {
  const manifests: Record<string, PackageManifest> = {};

  for (const directory of readWorkspaceDirectories(rootPath)) {
    const directoryPath = join(rootPath, directory);
    if (!existsSync(directoryPath)) {
      continue;
    }

    const entries = readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const name of entries) {
      const manifestPath = join(directoryPath, name, 'package.json');
      if (existsSync(manifestPath)) {
        manifests[`${directory}/${name}/package.json`] = JSON.parse(readFileSync(manifestPath, 'utf8'));
      }
    }
  }

  return manifests;
}
