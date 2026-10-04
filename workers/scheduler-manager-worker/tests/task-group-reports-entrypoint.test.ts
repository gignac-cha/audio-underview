import { describe, it, expect } from 'vitest';
import { exports } from 'cloudflare:workers';
import { TaskGroupReports } from '../sources/task-group-reports-entrypoint.ts';
import * as entryModule from '../sources/index.ts';

// Calls over RPC are in task-group-reports.test.ts; this file holds what the entrypoint answers
// as a Worker and what the entry module exports.

describe('the entry module', () => {
  it('exports only classes as named exports, besides the default', () => {
    // The Workers runtime refuses an entry module that exports anything else
    for (const [name, value] of Object.entries(entryModule)) {
      if (name === 'default') continue;
      expect(typeof value, `export ${name}`).toBe('function');
      // A plain function is a function too, but is not a class
      expect(Function.prototype.toString.call(value), `export ${name}`).toMatch(/^class\b/);
    }
  });

  it('exports the entrypoint of the task group reports and the Workflow class', () => {
    expect(entryModule.TaskGroupReports).toBe(TaskGroupReports);
    expect(entryModule).toHaveProperty('SchedulerRunWorkflow');
  });
});

describe('TaskGroupReports entrypoint', () => {
  it.each(['GET', 'POST'])('answers a %s fetch with 404', async (method) => {
    const reports = (exports as unknown as { TaskGroupReports: { fetch(url: string, init?: RequestInit): Promise<Response> } })
      .TaskGroupReports;

    const response = await reports.fetch('https://reports.example.com/', { method });

    expect(response.status).toBe(404);
  });
});
