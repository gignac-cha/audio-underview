import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createSupabaseClient } from '@audio-underview/supabase-connector';
import { createWorkerLogger } from '@audio-underview/logger';
import type { Environment } from './index.ts';
import { ServiceBindingCrawlerExecutionClient } from './crawler-execution-client.ts';
import { type ScheduledPipelineResult, runScheduledPipeline } from './scheduled-pipeline.ts';

export interface SchedulerRunParameters {
  schedulerID: string;
  /** ISO timestamp of the cron occurrence this run belongs to */
  scheduledFor: string;
}

const logger = createWorkerLogger({
  defaultContext: {
    module: 'scheduler-run-workflow',
  },
});

/**
 * Runs one scheduled occurrence of a scheduler. The logic lives in runScheduledPipeline.
 */
export class SchedulerRunWorkflow extends WorkflowEntrypoint<Environment, SchedulerRunParameters> {
  async run(event: WorkflowEvent<SchedulerRunParameters>, step: WorkflowStep): Promise<ScheduledPipelineResult> {
    const supabaseClient = createSupabaseClient({
      supabaseURL: this.env.SUPABASE_URL,
      supabaseSecretKey: this.env.SUPABASE_SECRET_KEY,
    });
    const crawlerExecutionClient = new ServiceBindingCrawlerExecutionClient(this.env.CRAWLER_MANAGER);

    return runScheduledPipeline(
      { supabaseClient, crawlerExecutionClient, logger },
      event.payload,
      step,
    );
  }
}
