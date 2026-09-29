import { fileURLToPath } from 'node:url';
import { buildWorkspaceGraph } from './graph.ts';
import { collectWorkspaceManifests } from './workspace-manifests.ts';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const GRAPH_RESOURCE_PATH = fileURLToPath(new URL('../resources/graph.json', import.meta.url));

/** The exact text `resources/graph.json` should hold for the current workspace manifests. */
export function createGraphResource(rootPath: string = REPOSITORY_ROOT): string {
  return `${JSON.stringify(buildWorkspaceGraph(collectWorkspaceManifests(rootPath)), null, 2)}\n`;
}
