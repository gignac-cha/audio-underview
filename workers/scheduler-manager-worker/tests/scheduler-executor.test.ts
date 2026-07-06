import { describe, expect, it } from 'vitest';
import { executeScheduler } from '../sources/scheduler-executor.ts';
import {
  createExecutorHarness,
  mockStage,
  RUN_ID,
  SCHEDULER_ID,
  silentLogger,
  USER_UUID,
} from './test-helpers.ts';

const run = (harness: ReturnType<typeof createExecutorHarness>, signal?: AbortSignal) =>
  executeScheduler(
    { services: harness.services, logger: silentLogger },
    SCHEDULER_ID,
    USER_UUID,
    RUN_ID,
    signal,
  );

describe('executeScheduler', () => {
  it('completes with result null for an empty pipeline', async () => {
    const harness = createExecutorHarness([]);
    await run(harness);

    expect(harness.runUpdates[0]).toMatchObject({ status: 'running' });
    expect(harness.runUpdates[1]).toMatchObject({ status: 'completed', result: null });
    expect(harness.schedulerUpdates[0]).toHaveProperty('last_run_at');
  });

  it('resolves the first input from input_schema defaults', async () => {
    const harness = createExecutorHarness([mockStage]);
    await run(harness);

    expect(harness.executions[0]?.input).toEqual({ url: 'https://example.com' });
    expect(harness.runUpdates.at(-1)).toMatchObject({ status: 'completed' });
  });

  it('chains stage outputs: stage N output === stage N+1 input', async () => {
    const stages = [
      { ...mockStage, stage_order: 0 },
      { ...mockStage, id: '00000000-0000-4000-8000-00000000000a', stage_order: 1 },
    ];
    const harness = createExecutorHarness(stages);
    harness.setExecuteImplementation((_crawlerID, input) =>
      Promise.resolve({ type: 'data', result: { previous: input } }),
    );
    await run(harness);

    expect(harness.executions[1]?.input).toEqual({
      previous: { url: 'https://example.com' },
    });
    expect(harness.runUpdates.at(-1)).toMatchObject({
      status: 'completed',
      result: { previous: { previous: { url: 'https://example.com' } } },
    });
  });

  it('marks the run failed when a stage throws', async () => {
    const harness = createExecutorHarness([mockStage]);
    harness.setExecuteImplementation(() => Promise.reject(new Error('CodeRunner error 422')));
    await run(harness);

    expect(harness.runUpdates.at(-1)).toMatchObject({
      status: 'failed',
      error: 'CodeRunner error 422',
    });
    expect(harness.schedulerUpdates).toHaveLength(1); // last_run_at은 실패해도 갱신
  });

  describe('fan-out', () => {
    const fanOutStage = {
      ...mockStage,
      input_schema: { items: { default: ['a', 'b'] } },
      fan_out_field: 'items',
    };

    it('fans out over the array field and feeds results to the next stage', async () => {
      const harness = createExecutorHarness([fanOutStage]);
      harness.setExecuteImplementation((_crawlerID, input) =>
        Promise.resolve({ type: 'data', result: `ok:${String(input)}` }),
      );
      await run(harness);

      expect(harness.executions.map((execution) => execution.input)).toEqual(['a', 'b']);
      expect(harness.runUpdates.at(-1)).toMatchObject({
        status: 'completed',
        result: ['ok:a', 'ok:b'],
      });
      const fanOutWrite = harness.stageRunWrites.find(
        (write) => write.operation === 'update' && write.items_total !== undefined,
      );
      expect(fanOutWrite).toMatchObject({ items_total: 2, items_succeeded: 2, items_failed: 0 });
    });

    it('completes with [] for an empty fan-out array', async () => {
      const harness = createExecutorHarness([
        { ...fanOutStage, input_schema: { items: { default: [] } } },
      ]);
      await run(harness);

      expect(harness.runUpdates.at(-1)).toMatchObject({ status: 'completed', result: [] });
      expect(
        harness.stageRunWrites.find((write) => write.operation === 'update'),
      ).toMatchObject({ items_total: 0, items_succeeded: 0, items_failed: 0 });
    });

    it('marks the run partially_failed when some items fail', async () => {
      const harness = createExecutorHarness([fanOutStage]);
      harness.setExecuteImplementation((_crawlerID, input) =>
        input === 'a'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ type: 'data', result: input }),
      );
      await run(harness);

      expect(harness.runUpdates.at(-1)).toMatchObject({ status: 'partially_failed' });
    });

    it('fails the run when all items fail', async () => {
      const harness = createExecutorHarness([fanOutStage]);
      harness.setExecuteImplementation(() => Promise.reject(new Error('boom')));
      await run(harness);

      expect(harness.runUpdates.at(-1)).toMatchObject({
        status: 'failed',
        error: 'Stage 0: all fan-out items failed',
      });
    });

    it('fails when fan_out_field is missing from the input', async () => {
      const harness = createExecutorHarness([
        { ...fanOutStage, input_schema: { other: { default: 1 } } },
      ]);
      await run(harness);

      expect(harness.runUpdates.at(-1)).toMatchObject({ status: 'failed' });
      expect(String(harness.runUpdates.at(-1)?.error)).toContain('not found in input');
    });

    it('fails when fan_out_field is not an array', async () => {
      const harness = createExecutorHarness([
        { ...fanOutStage, input_schema: { items: { default: 'not-array' } } },
      ]);
      await run(harness);

      expect(String(harness.runUpdates.at(-1)?.error)).toContain('is not an array');
    });
  });

  it('skips all writes after the signal aborts', async () => {
    const abortController = new AbortController();
    const harness = createExecutorHarness([mockStage]);
    harness.setExecuteImplementation(() => {
      abortController.abort(); // 실행 중 timeout 발생 시뮬레이션
      return Promise.resolve({ type: 'data', result: 1 });
    });
    await run(harness, abortController.signal);

    // running 기록 이후로는 run/scheduler 쓰기 없음
    expect(harness.runUpdates).toHaveLength(1);
    expect(harness.runUpdates[0]).toMatchObject({ status: 'running' });
    expect(harness.schedulerUpdates).toHaveLength(0);
  });

  it('does not rethrow when recording the failure fails (로그만)', async () => {
    const harness = createExecutorHarness([mockStage]);
    harness.setExecuteImplementation(() => Promise.reject(new Error('boom')));
    harness.services.runs.update = () => Promise.reject(new Error('db down'));

    await expect(run(harness)).resolves.toBeUndefined();
  });
});
