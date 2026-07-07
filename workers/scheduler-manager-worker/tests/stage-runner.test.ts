import { describe, expect, it } from 'vitest';
import {
  executeFanOut,
  executeStage,
  resolveDefaultInput,
} from '../sources/stage-runner.ts';
import {
  createFakeServices,
  mockStage,
  mockStageRun,
  RUN_ID,
  silentLogger,
} from './test-helpers.ts';

describe('resolveDefaultInput', () => {
  it('collects defaults from descriptor objects', () => {
    expect(
      resolveDefaultInput({
        url: { type: 'string', default: 'https://example.com' },
        depth: { type: 'number', default: 2 },
      }),
    ).toEqual({ url: 'https://example.com', depth: 2 });
  });

  it('preserves falsy defaults (null/false)', () => {
    expect(
      resolveDefaultInput({ flag: { default: false }, marker: { default: null } }),
    ).toEqual({ flag: false, marker: null });
  });

  it('skips fields without default and non-object descriptors', () => {
    expect(resolveDefaultInput({ url: { type: 'string' }, plain: 'string' })).toEqual({});
  });

  it('returns {} for an empty schema', () => {
    expect(resolveDefaultInput({})).toEqual({});
  });

  it.each([['text'], [42], [null], [[1, 2]]])('throws for non-object schema (%s)', (schema) => {
    expect(() => resolveDefaultInput(schema)).toThrow('Invalid input_schema: expected object');
  });
});

describe('executeStage', () => {
  it('records running → completed and returns the output', async () => {
    const writes: Record<string, unknown>[] = [];
    const services = createFakeServices({
      stageRuns: {
        create: (input) => {
          writes.push({ operation: 'create', ...(input as object) });
          return Promise.resolve(mockStageRun);
        },
        update: (_id, _runID, input) => {
          writes.push({ operation: 'update', ...(input as object) });
          return Promise.resolve({ ...mockStageRun, ...(input as object) });
        },
      },
      crawlerExecution: {
        execute: () => Promise.resolve({ type: 'web', result: { count: 3 } }),
      },
    });

    const result = await executeStage({ services, logger: silentLogger }, RUN_ID, mockStage, {
      url: 'https://example.com',
    });

    expect(result.output).toEqual({ count: 3 });
    expect(writes[0]).toMatchObject({ operation: 'create', status: 'running' });
    expect(writes[1]).toMatchObject({ operation: 'update', status: 'completed' });
  });

  it('falls back to the original stage run when the update returns undefined', async () => {
    const services = createFakeServices({
      stageRuns: {
        create: () => Promise.resolve(mockStageRun),
        update: () => Promise.resolve(undefined),
      },
      crawlerExecution: { execute: () => Promise.resolve({ type: 'data', result: 1 }) },
    });

    const result = await executeStage({ services, logger: silentLogger }, RUN_ID, mockStage, {});
    expect(result.stageRun).toBe(mockStageRun);
  });

  it('records failure and rethrows', async () => {
    const writes: Record<string, unknown>[] = [];
    const services = createFakeServices({
      stageRuns: {
        create: () => Promise.resolve(mockStageRun),
        update: (_id, _runID, input) => {
          writes.push(input);
          return Promise.resolve(mockStageRun);
        },
      },
      crawlerExecution: { execute: () => Promise.reject(new Error('CodeRunner error 422')) },
    });

    await expect(
      executeStage({ services, logger: silentLogger }, RUN_ID, mockStage, {}),
    ).rejects.toThrow('CodeRunner error 422');
    expect(writes[0]).toMatchObject({ status: 'failed', error: 'CodeRunner error 422' });
  });

  it('throws immediately when the signal is already aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    await expect(
      executeStage(
        { services: createFakeServices(), logger: silentLogger },
        RUN_ID,
        mockStage,
        {},
        abortController.signal,
      ),
    ).rejects.toThrow('Stage execution aborted');
  });
});

describe('executeFanOut', () => {
  const createServices = (
    execute: (crawlerID: string, input: unknown) => Promise<{ type: 'web' | 'data'; result?: unknown }>,
  ) => createFakeServices({ crawlerExecution: { execute } });

  it('runs items sequentially and reports completed', async () => {
    const order: unknown[] = [];
    const services = createServices((_crawlerID, input) => {
      order.push(input);
      return Promise.resolve({ type: 'data', result: `ok:${String(input)}` });
    });

    const result = await executeFanOut({ services, logger: silentLogger }, mockStage, [1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      status: 'completed',
      itemsTotal: 3,
      itemsSucceeded: 3,
      itemsFailed: 0,
    });
    expect(result.results).toEqual(['ok:1', 'ok:2', 'ok:3']);
  });

  it('compacts failed slots by default but preserves null successes', async () => {
    const services = createServices((_crawlerID, input) =>
      input === 'fail'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ type: 'data', result: input === 'null' ? null : input }),
    );

    const result = await executeFanOut({ services, logger: silentLogger }, mockStage, [
      'a',
      'fail',
      'null',
    ]);
    expect(result.status).toBe('partially_failed');
    expect(result.results).toEqual(['a', null]); // 실패 slot 제거, null 성공은 보존
  });

  it('preserve 전략은 실패 슬롯을 null로 유지한다', async () => {
    const services = createServices((_crawlerID, input) =>
      input === 'fail'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ type: 'data', result: input }),
    );

    const result = await executeFanOut(
      { services, logger: silentLogger },
      { ...mockStage, fan_out_strategy: 'preserve' },
      ['a', 'fail', 'b'],
    );
    expect(result.results).toEqual(['a', null, 'b']);
  });

  it('reports failed when every item fails', async () => {
    const services = createServices(() => Promise.reject(new Error('boom')));
    const result = await executeFanOut({ services, logger: silentLogger }, mockStage, [1, 2]);
    expect(result).toMatchObject({ status: 'failed', itemsFailed: 2, itemsSucceeded: 0 });
    expect(result.results).toEqual([]);
  });

  it('handles empty arrays', async () => {
    const services = createServices(() => Promise.reject(new Error('should not run')));
    const result = await executeFanOut({ services, logger: silentLogger }, mockStage, []);
    expect(result).toMatchObject({ status: 'completed', itemsTotal: 0 });
  });
});
