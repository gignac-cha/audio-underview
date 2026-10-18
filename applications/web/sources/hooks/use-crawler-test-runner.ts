import { useState } from 'react';
import type { CrawlerType } from '@audio-underview/supabase-connector';
import type { RunOutput } from '../components/crawlers/RunOutputPanel.tsx';
import type { CrawlerRunDetail } from '../schemas/crawler-runs.ts';
import { tryParseSchema, type FormState } from './crawler-form-helpers.ts';
import { useGetCrawlerRun, useRunCrawler, type CrawlerDraft, type RunCrawlerRequest } from './use-crawler-runs.ts';

type RunTarget = RunCrawlerRequest['target'];

const TARGET_LABELS: Record<RunTarget, string> = {
  saved: 'Runs the saved crawler.',
  'saved-draft': 'Test run of unsaved changes.',
  'new-draft': 'Test run of a crawler that is not saved yet.',
};

interface CrawlerTestRunnerOptions {
  // The id of the saved crawler; undefined while a new crawler is being made
  crawlerID: string | undefined;
  crawlerType: CrawlerType;
  form: FormState | undefined;
  isDirty: boolean;
}

function describeDetail(run: CrawlerRunDetail): RunOutput {
  if (run.status === 'completed') {
    return { status: 'success', result: run.result, logs: run.logs, logsTruncated: run.logs_truncated };
  }
  return {
    status: 'failed',
    failure: { code: run.error_code ?? 'unknown_error', description: run.error ?? 'The run failed.' },
    logs: run.logs,
    logsTruncated: run.logs_truncated,
  };
}

/**
 * The test runner of the crawler editor: the input, which route a run takes, the output of the
 * last run or of a run picked from the history.
 *
 * - A saved crawler without changes runs as it is (a direct run).
 * - A saved crawler with changes runs the changes as a test run of that crawler.
 * - A crawler that is not saved yet runs as a test run without a crawler.
 */
export function useCrawlerTestRunner({ crawlerID, crawlerType, form, isDirty }: CrawlerTestRunnerOptions) {
  const [testURL, setTestURL] = useState('');
  const [testInput, setTestInputText] = useState('');
  const [testInputError, setTestInputError] = useState<string>();
  const [selectedRunID, setSelectedRunID] = useState<string>();

  const { runCrawler, status: runStatus, result: runResult, error: runError } = useRunCrawler();
  const isRunning = runStatus === 'pending';

  // Test runs of a crawler that is not saved are listed under null
  const historyCrawlerID = crawlerID ?? null;
  const selectedRun = useGetCrawlerRun(historyCrawlerID, selectedRunID);

  const target: RunTarget = crawlerID === undefined ? 'new-draft' : isDirty ? 'saved-draft' : 'saved';

  // A draft sends the input schema of a data crawler, so it has to be valid JSON
  const blockedReason =
    crawlerType === 'data' && target !== 'saved' && form !== undefined && tryParseSchema(form.input_schema) === undefined
      ? 'Fix the input schema before running.'
      : undefined;

  const canRun =
    form !== undefined && !isRunning && blockedReason === undefined && (crawlerType === 'data' || testURL !== '');

  const setTestInput = (value: string) => {
    setTestInputText(value);
    setTestInputError(undefined);
  };

  const run = () => {
    if (!form || !canRun) return false;

    let input: unknown;
    if (crawlerType === 'web') {
      input = { url: testURL };
    } else if (testInput.trim() !== '') {
      try {
        input = JSON.parse(testInput);
      } catch {
        setTestInputError('Input must be valid JSON.');
        return true;
      }
    }

    setSelectedRunID(undefined);

    if (target === 'saved' && crawlerID !== undefined) {
      runCrawler({ target, crawlerID, input });
      return true;
    }

    const draft: CrawlerDraft = {
      code: form.code,
      environment_variable_names: form.environment_variable_names,
    };
    const urlPattern = form.url_pattern.trim();
    if (crawlerType === 'web' && urlPattern !== '') {
      draft.url_pattern = urlPattern;
    }
    if (crawlerType === 'data') {
      draft.input_schema = tryParseSchema(form.input_schema);
    }

    if (crawlerID !== undefined) {
      runCrawler({ target: 'saved-draft', crawlerID, input, ...draft });
    } else {
      runCrawler({ target: 'new-draft', type: crawlerType, input, ...draft });
    }
    return true;
  };

  let output: RunOutput;
  let caption: string | undefined;
  if (selectedRunID !== undefined) {
    if (selectedRun.run) {
      output = describeDetail(selectedRun.run);
      const startedAt = new Date(selectedRun.run.started_at).toLocaleString();
      caption = `Showing a past ${selectedRun.run.kind === 'test' ? 'test run' : 'run'} from ${startedAt}.`;
    } else if (selectedRun.error) {
      output = { status: 'error', error: selectedRun.error };
    } else {
      output = { status: 'loading' };
    }
  } else if (isRunning) {
    output = { status: 'running' };
  } else if (runError) {
    output = { status: 'error', error: runError };
  } else if (runResult?.status === 'completed') {
    output = {
      status: 'success',
      result: runResult.result,
      logs: runResult.logs,
      logsTruncated: runResult.logs_truncated,
    };
  } else if (runResult?.status === 'failed') {
    output = {
      status: 'failed',
      failure: { code: runResult.error, description: runResult.error_description },
      logs: runResult.logs,
      logsTruncated: runResult.logs_truncated,
    };
  } else {
    output = { status: 'idle' };
  }

  return {
    testURL,
    setTestURL,
    testInput,
    setTestInput,
    testInputError,
    run,
    canRun,
    isRunning,
    blockedReason,
    targetLabel: TARGET_LABELS[target],
    output,
    caption,
    historyCrawlerID,
    selectedRunID,
    selectRun: setSelectedRunID,
  };
}
