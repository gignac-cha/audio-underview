import { describe, expect, it } from 'vitest';
import { introspectWorkflow } from 'cloudflare:test';
import type { Environment } from '../sources/environment.ts';
import { NewscastTaskGroup } from '../sources/task-group.ts';
import { useNewscastsInMemorySupabase } from './newscasts-in-memory-supabase.ts';
import {
  NO_KEY_ANSWER,
  TEXT_TO_SPEECH_PATH,
  configureVault,
  environment,
  receiveExecutionContext,
  schedulerCalls,
  textToSpeechAnswer,
} from './workflow-harness.ts';

const supabase = useNewscastsInMemorySupabase();

// The real NEWSCAST_WORKFLOW binding: the group creates the instances with createBatch, and the
// Workflows engine runs their steps, from the start of the stage run to the report that ends it
describe('a stage run from start to report', () => {
  it('starts a verbatim newscast that the engine finishes, and completes the stage run', async () => {
    const userUUID = crypto.randomUUID();
    const stageRunID = crypto.randomUUID();
    await configureVault(userUUID, {
      [`proxy:google:${TEXT_TO_SPEECH_PATH}`]: textToSpeechAnswer(),
      'proxy:openai': NO_KEY_ANSWER,
    });
    await using introspector = await introspectWorkflow(environment.NEWSCAST_WORKFLOW);
    await introspector.modifyAll(async (modifier) => {
      await modifier.disableRetryDelays();
    });
    const group = new NewscastTaskGroup(await receiveExecutionContext(), environment as Environment);

    await group.startTaskGroupRun({
      stageRunID,
      taskGroupID: 'newscast',
      taskGroupVersion: 1,
      input: { text: '화자1: 첫 문장입니다.\n화자2: 둘째 문장입니다.' },
      settings: { verbatim: true },
      userUUID,
    });

    const instances = await introspector.get();
    expect(instances).toHaveLength(1);
    await instances[0].waitForStatus('complete');

    const [row] = supabase.tables.newscasts ?? [];
    expect(row).toMatchObject({ status: 'done', stage_run_id: stageRunID, source_index: 0 });
    expect(await schedulerCalls(stageRunID)).toEqual([
      { method: 'reportProgress', stageRunID, progress: { message: '0 of 1 newscasts finished', completed: 0, total: 1 } },
      { method: 'complete', stageRunID, output: { newscasts: [{ id: row.id, status: 'done', title: '첫 문장입니다.' }] } },
    ]);
    expect(await environment.NEWSCAST_AUDIO.head(`${row.id as string}/part-1`)).not.toBeNull();
  });
});
