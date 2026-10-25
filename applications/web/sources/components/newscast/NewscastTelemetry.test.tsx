import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { JobDetails, JobStatus } from '@audio-underview/newscast-core';
import { NewscastTelemetry } from './NewscastTelemetry.tsx';

/** A full organize telemetry block (the healthy, multi-part case). */
const ORGANIZE: NonNullable<JobDetails['organize']> = {
  provider: 'google',
  model: 'gemini-2.5-flash',
  unitCount: 12,
  estimatedScriptCharacters: 11_700,
  partCount: 3,
  turnTargets: [50, 50, 50],
  promptTokens: 4_200,
  completionTokens: 3_100,
};

/** A finished newscast carrying `details` — the surface this component renders for. */
function doneStatus(details: JobDetails): JobStatus {
  return {
    id: 'job-1',
    stage: 'done',
    stageProgress: 1,
    overallProgress: 1,
    status: 'done',
    details,
  };
}

describe('NewscastTelemetry — compact stage rows', () => {
  test('renders one row per working stage with its key metric', async () => {
    const screen = await render(
      <NewscastTelemetry
        status={doneStatus({
          organize: ORGANIZE,
          script: { provider: 'google', model: 'gemini-2.5-pro', turns: 117, characters: 9_100 },
          tts: { chunks: 15, audioDurationMs: 1_190_000 },
          merge: { mp3Bytes: 19_084_083, aligned: true },
        })}
      />,
    );

    const text = screen.container.textContent ?? '';
    // Six rows, but only the four stages this newscast actually ran are pressable
    expect(page.getByTestId(/^stage-row-/).elements()).toHaveLength(6);
    expect(page.getByRole('button').elements()).toHaveLength(4);
    expect(text).toContain('Organize material');
    expect(text).toContain('12 units · 3 parts');
    expect(text).toContain('117 turns');
    expect(text).toContain('15 chunks · 19:50');
    expect(text).toContain('18.2 MB');
    // The row itself stays one line — models and tokens live in the dialog
    expect(text).not.toContain('gemini-2.5-flash');
    expect(text).not.toContain('turn targets');
  });

  test('moves the organize detail behind the row’s dialog', async () => {
    await render(<NewscastTelemetry status={doneStatus({ organize: ORGANIZE })} />);

    await page.getByRole('button', { name: /Organize material/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Organize material' });
    await expect.element(dialog).toHaveTextContent('gemini-2.5-flash');
    await expect.element(dialog).toHaveTextContent('11,700 est chars');
    await expect.element(dialog).toHaveTextContent('turn targets 50 · 50 · 50');
    expect(dialog.element().textContent).not.toContain('degraded');
  });

  test('opens the per-part rollup from the organize row', async () => {
    await render(
      <NewscastTelemetry
        status={doneStatus({
          partsSummary: [
            { index: 1, turns: 41, characters: 3_170, audioDurationMs: 388_000 },
            { index: 2, turns: 48, characters: 3_744, audioDurationMs: 459_000 },
          ],
        })}
      />,
    );
    // Even without organize telemetry the row still reports the part count
    await expect.element(page.getByRole('button', { name: /Organize material/ })).toHaveTextContent('2 parts');

    await page.getByRole('button', { name: /Organize material/ }).click();

    const dialog = page.getByRole('dialog', { name: 'Organize material' });
    await expect.element(dialog).toHaveTextContent('Part 1 · 41 turns · 3,170 chars');
    await expect.element(dialog).toHaveTextContent('Part 2 · 48 turns · 3,744 chars');
  });

  test('still lists a stage that produced nothing, marked as never run', async () => {
    await render(<NewscastTelemetry status={doneStatus({ crawlList: { count: 1, titles: ['t'], bytes: 100 } })} />);

    const organizeRow = page.getByTestId('stage-row-organize');
    expect(organizeRow.element().textContent).toBe('Organize material');
    expect(organizeRow.element().tagName).not.toBe('BUTTON');
    await expect.element(page.getByRole('button', { name: /Fetch list/ })).toHaveTextContent('1 article · 100 B');
  });

  test('renders nothing when there is no telemetry at all', async () => {
    const screen = await render(<NewscastTelemetry status={doneStatus({})} />);

    expect(screen.container.textContent).toBe('');
  });
});
