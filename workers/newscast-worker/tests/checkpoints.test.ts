import { describe, expect, it } from 'vitest';

import {
  articlesCheckpointKey,
  checkpointPrefix,
  isArticlesCheckpointUsable,
  isMergedPartCheckpointUsable,
  isPlanCheckpointUsable,
  isScriptPartCheckpointUsable,
  isSignalCheckpointUsable,
  isTtsPartCheckpointUsable,
  mergedPartCheckpointKey,
  parseCheckpoint,
  planCheckpointKey,
  resolvePartReuse,
  resolvePipelineReuse,
  resolveVerbatimPipelineReuse,
  scriptPartCheckpointKey,
  signalCheckpointKey,
  ttsPartCheckpointKey,
} from '../sources/checkpoints.ts';

const SCOPE_ID = 'user-1/newscast-1';

describe('checkpoint key builders (design §3a)', () => {
  it('namespaces every key under the scoped chk/ prefix', () => {
    expect(checkpointPrefix(SCOPE_ID)).toBe('chk/user-1/newscast-1/');
    expect(articlesCheckpointKey(SCOPE_ID)).toBe('chk/user-1/newscast-1/articles');
    expect(planCheckpointKey(SCOPE_ID)).toBe('chk/user-1/newscast-1/plan');
    expect(signalCheckpointKey(SCOPE_ID)).toBe('chk/user-1/newscast-1/signal');
    expect(scriptPartCheckpointKey(SCOPE_ID, 2)).toBe('chk/user-1/newscast-1/script/p2');
    expect(ttsPartCheckpointKey(SCOPE_ID, 2)).toBe('chk/user-1/newscast-1/tts/p2');
    expect(mergedPartCheckpointKey(SCOPE_ID, 2)).toBe('chk/user-1/newscast-1/part/p2');
  });

  it('keeps every key inside the prefix finalize deletes', () => {
    const keys = [
      articlesCheckpointKey(SCOPE_ID),
      planCheckpointKey(SCOPE_ID),
      signalCheckpointKey(SCOPE_ID),
      scriptPartCheckpointKey(SCOPE_ID, 1),
      ttsPartCheckpointKey(SCOPE_ID, 1),
      mergedPartCheckpointKey(SCOPE_ID, 1),
    ];
    for (const key of keys) {
      expect(key.startsWith(checkpointPrefix(SCOPE_ID))).toBe(true);
    }
  });

  it('namespaces parts so two parts never collide', () => {
    expect(scriptPartCheckpointKey(SCOPE_ID, 1)).not.toBe(
      scriptPartCheckpointKey(SCOPE_ID, 2),
    );
    expect(mergedPartCheckpointKey('other', 1)).not.toBe(
      mergedPartCheckpointKey(SCOPE_ID, 1),
    );
  });
});

describe('parseCheckpoint', () => {
  it('parses a stored object payload', () => {
    expect(parseCheckpoint<{ generated: boolean }>('{"generated":true}')).toEqual({
      generated: true,
    });
  });

  it('parses a stored array payload', () => {
    expect(parseCheckpoint<number[]>('[1,2]')).toEqual([1, 2]);
  });

  it('treats a missing / empty value as a miss', () => {
    expect(parseCheckpoint(null)).toBeNull();
    expect(parseCheckpoint(undefined)).toBeNull();
    expect(parseCheckpoint('')).toBeNull();
  });

  it('treats malformed JSON as a miss instead of throwing', () => {
    expect(parseCheckpoint('{broken')).toBeNull();
  });

  it('treats a non-object payload as a miss', () => {
    expect(parseCheckpoint('42')).toBeNull();
    expect(parseCheckpoint('"text"')).toBeNull();
    expect(parseCheckpoint('null')).toBeNull();
  });
});

describe('checkpoint usability guards', () => {
  it('accepts a non-empty article list only', () => {
    expect(isArticlesCheckpointUsable([{ title: 'a', content: 'b' }])).toBe(true);
    expect(isArticlesCheckpointUsable([])).toBe(false);
    expect(isArticlesCheckpointUsable(null)).toBe(false);
  });

  it('rejects a DEGRADED plan so a resume re-attempts organize (§3b-2)', () => {
    const healthy = { units: [], plans: [{ index: 1, unitIndexes: [], turnTarget: 30 }] };
    expect(isPlanCheckpointUsable(healthy)).toBe(true);
    expect(isPlanCheckpointUsable({ ...healthy, degraded: true })).toBe(false);
    // Only an explicit `true` is degraded; the flag is absent on healthy plans.
    expect(isPlanCheckpointUsable({ ...healthy, degraded: false })).toBe(true);
  });

  it('rejects a plan with no parts or malformed arrays', () => {
    expect(isPlanCheckpointUsable({ units: [], plans: [] })).toBe(false);
    expect(isPlanCheckpointUsable({ units: 'nope', plans: [{ index: 1 }] })).toBe(false);
    expect(isPlanCheckpointUsable(null)).toBe(false);
  });

  it('treats a recorded `generated: false` sting verdict as a HIT', () => {
    expect(isSignalCheckpointUsable({ generated: false })).toBe(true);
    expect(isSignalCheckpointUsable({ generated: true })).toBe(true);
    expect(isSignalCheckpointUsable({})).toBe(false);
    expect(isSignalCheckpointUsable(null)).toBe(false);
  });

  it('accepts a script checkpoint only when it carries dialogue lines', () => {
    expect(
      isScriptPartCheckpointUsable({
        lines: [{ speaker: 1, text: '안녕하세요' }],
        turns: 1,
        characters: 5,
      }),
    ).toBe(true);
    expect(isScriptPartCheckpointUsable({ lines: [], turns: 0, characters: 0 })).toBe(
      false,
    );
    expect(isScriptPartCheckpointUsable(null)).toBe(false);
  });

  it('accepts a TTS checkpoint carrying its per-chunk metadata', () => {
    expect(isTtsPartCheckpointUsable({ chunks: [] })).toBe(true);
    expect(isTtsPartCheckpointUsable({ chunks: [{ byteLength: 10, sampleRate: 24000 }] }))
      .toBe(true);
    expect(isTtsPartCheckpointUsable({})).toBe(false);
  });

  it('accepts a merged-part checkpoint only with a well-formed part', () => {
    const merged = {
      part: {
        index: 1,
        audioKey: 'newscast-1/part-1',
        script: [{ speaker: 1, text: '안녕하세요' }],
        segments: [],
        durationMs: 1000,
      },
      mp3Bytes: 100,
      aligned: false,
    };
    expect(isMergedPartCheckpointUsable(merged)).toBe(true);
    expect(isMergedPartCheckpointUsable({ ...merged, part: { ...merged.part, audioKey: '' } }))
      .toBe(false);
    expect(isMergedPartCheckpointUsable({ mp3Bytes: 100 })).toBe(false);
    expect(isMergedPartCheckpointUsable(null)).toBe(false);
  });
});

describe('resolvePipelineReuse (§3b — reuse the front, re-run the rest)', () => {
  const allHits = { articles: true, plan: true, signal: true };

  it('reuses NOTHING on a normal (non-resume) run', () => {
    expect(resolvePipelineReuse(false, allHits)).toEqual({
      articles: false,
      plan: false,
      signal: false,
      parts: false,
    });
  });

  it('reuses every leading stage when all checkpoints hit', () => {
    expect(resolvePipelineReuse(true, allHits)).toEqual({
      articles: true,
      plan: true,
      signal: true,
      parts: true,
    });
  });

  it('makes everything after the FIRST miss live', () => {
    expect(resolvePipelineReuse(true, { ...allHits, articles: false })).toEqual({
      articles: false,
      plan: false,
      signal: false,
      parts: false,
    });
    expect(resolvePipelineReuse(true, { ...allHits, plan: false })).toEqual({
      articles: true,
      plan: false,
      signal: false,
      parts: false,
    });
  });

  it('lets a missing sting re-generate WITHOUT forcing the parts live', () => {
    // The sting is an optional, harmless artifact; per-part reuse is premised on
    // the part plan (§3b-4), not on the sting.
    expect(resolvePipelineReuse(true, { ...allHits, signal: false })).toEqual({
      articles: true,
      plan: true,
      signal: false,
      parts: true,
    });
  });
});

describe('resolveVerbatimPipelineReuse (verbatim design §3 — a deterministic front half)', () => {
  it('reuses nothing on a normal (non-resume) run', () => {
    expect(resolveVerbatimPipelineReuse(false, { signal: true })).toEqual({
      articles: false,
      plan: false,
      signal: false,
      parts: false,
    });
  });

  it('opens per-part reuse on a resume even though there is no plan checkpoint', () => {
    // THE POINT OF THE FUNCTION. A verbatim newscast never writes an articles or plan
    // checkpoint (it has no crawl and no organization), so the ordinary rule would
    // miss on both, force `parts: false`, and re-synthesize audio the failed run had
    // already paid for. The parts are re-derived from the replayed pasted text, so
    // they are guaranteed identical — which is exactly the premise §3b-4 usually
    // takes from a reused plan.
    expect(resolveVerbatimPipelineReuse(true, { signal: false })).toEqual({
      articles: false,
      plan: false,
      signal: false,
      parts: true,
    });
  });

  it('still reuses the sting verdict, because THAT one is a paid call', () => {
    expect(resolveVerbatimPipelineReuse(true, { signal: true })).toEqual({
      articles: false,
      plan: false,
      signal: true,
      parts: true,
    });
  });

  it('never claims the crawl/organize stages were reused — they never ran', () => {
    for (const resume of [false, true]) {
      const reuse = resolveVerbatimPipelineReuse(resume, { signal: true });
      expect(reuse.articles).toBe(false);
      expect(reuse.plan).toBe(false);
    }
  });
});

describe('resolvePartReuse (§3b-4 — parts are independent)', () => {
  it('runs a part fully live when per-part reuse is not eligible', () => {
    expect(resolvePartReuse(false, { merged: true, script: true, tts: true })).toEqual({
      mode: 'live',
      reuseChunkAudio: false,
      reuseChunkMetas: false,
    });
  });

  it('skips a part entirely when its merge output is checkpointed', () => {
    expect(resolvePartReuse(true, { merged: true, script: true, tts: true })).toEqual({
      mode: 'merged',
      reuseChunkAudio: false,
      reuseChunkMetas: false,
    });
  });

  it('reuses the dialogue and the chunk audio when only the merge is missing', () => {
    expect(resolvePartReuse(true, { merged: false, script: true, tts: true })).toEqual({
      mode: 'script',
      reuseChunkAudio: true,
      reuseChunkMetas: true,
    });
  });

  it('still reuses whatever chunks exist when the part died mid-TTS', () => {
    // No tts checkpoint (it is written only after ALL of a part's chunks land), so
    // the metadata is unavailable but the already-stored chunk audio is not.
    expect(resolvePartReuse(true, { merged: false, script: false, tts: false }).mode).toBe(
      'live',
    );
    expect(resolvePartReuse(true, { merged: false, script: true, tts: false })).toEqual({
      mode: 'script',
      reuseChunkAudio: true,
      reuseChunkMetas: false,
    });
  });

  it('decides each part on its own inputs', () => {
    const first = resolvePartReuse(true, { merged: true, script: true, tts: true });
    const second = resolvePartReuse(true, { merged: false, script: false, tts: false });
    expect(first.mode).toBe('merged');
    expect(second.mode).toBe('live');
  });
});
