import { describe, expect, it } from 'vitest';
import { readWorkspaceDirectories } from './workspaces.ts';

describe('readWorkspaceDirectories', () => {
  it('reads the package globs and stops at the next top-level key', () => {
    const file = ['packages:', '  - packages/*', "  - 'workers/*'", '  - "tools/*"', '', 'catalogs:', '  - other/*'].join('\n');
    expect(readWorkspaceDirectories(file)).toEqual(['packages', 'workers', 'tools']);
  });
});
