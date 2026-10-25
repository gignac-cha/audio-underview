import { z } from 'zod';

/**
 * What the New newscast panel reads while it starts a newscast: the template scheduler the
 * newscast worker keeps for each source, and the parts of a scheduler run that show whether its
 * form waits for an answer. Unknown keys are dropped, so a field the scheduler adds later does not
 * break the panel.
 */

export const NEWSCAST_SOURCES = ['geeknews', 'url', 'text'] as const;

export const newscastSourceSchema = z.enum(NEWSCAST_SOURCES);

export type NewscastSource = z.infer<typeof newscastSourceSchema>;

/** The 200 body of `POST /newscasts/schedulers` (newscast worker). */
export const newscastTemplateSchema = z.object({
  scheduler_id: z.string(),
  form_stage_id: z.string(),
  newscast_stage_id: z.string(),
  source: newscastSourceSchema,
});

export type NewscastTemplate = z.infer<typeof newscastTemplateSchema>;

/** One choice of a resolved form field. Labels come from crawled content and are shown as text only. */
export const formChoiceSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

/** One field of a resolved form (`form.fields[]` of a form stage run). */
export const formFieldSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  widget: z.string(),
  required: z.boolean(),
  choices: z.array(formChoiceSchema).optional(),
  minItems: z.number().optional(),
  maxItems: z.number().optional(),
  maxLength: z.number().optional(),
});

export type FormField = z.infer<typeof formFieldSchema>;

/** The `form` of a form stage run while it waits for an answer. */
export const stageRunFormSchema = z.object({
  fields: z.array(formFieldSchema),
  expires_at: z.string(),
});

export type StageRunForm = z.infer<typeof stageRunFormSchema>;

/** `GET /schedulers/:id/runs/:runID/stage-runs/:stageRunID`, the fields the panel reads. */
export const formStageRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().nullable().optional(),
  form: stageRunFormSchema.nullable().optional(),
});

/** One stage run summary of a run. */
export const stageRunSummarySchema = z.object({
  id: z.string(),
  stage_id: z.string(),
  status: z.string(),
  error: z.string().nullable().optional(),
});

/** `GET /schedulers/:id/runs/:runID`, the fields the panel reads. */
export const schedulerRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  error: z.string().nullable().optional(),
  stage_runs: z.array(stageRunSummarySchema),
});

export type SchedulerRun = z.infer<typeof schedulerRunSchema>;

/** `GET /schedulers/:id/runs`, newest first. */
export const schedulerRunListSchema = z.object({
  data: z.array(z.object({ id: z.string(), status: z.string() })),
});

/** A run is still going while it is pending or running; its form stage run alone waits. */
export function isRunInProgress(status: string): boolean {
  return status === 'pending' || status === 'running';
}
