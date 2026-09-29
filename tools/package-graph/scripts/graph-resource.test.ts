import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GRAPH_RESOURCE_PATH, createGraphResource } from './graph-resource.ts';
import { readWorkspaceDirectories } from './workspace-manifests.ts';
import { REPOSITORY_ROOT } from './graph-resource.ts';

describe('resources/graph.json', () => {
  it('matches the workspace package manifests — run `pnpm generate` when this fails', () => {
    expect(readFileSync(GRAPH_RESOURCE_PATH, 'utf8')).toBe(createGraphResource());
  });
});

describe('readWorkspaceDirectories', () => {
  it('reads the workspace directories declared in pnpm-workspace.yaml', () => {
    expect(readWorkspaceDirectories(REPOSITORY_ROOT)).toEqual(['packages', 'applications', 'workers', 'functions', 'tools']);
  });
});
