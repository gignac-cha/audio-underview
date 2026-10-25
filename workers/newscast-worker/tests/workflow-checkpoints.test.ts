import { describe, expect, it } from 'vitest';
import { readCheckpoint, resolveCheckpointScope } from '../sources/workflow.ts';

const USER = '11111111-1111-5111-8111-111111111111';
const NEWSCAST = 'newscast-1';

/** An in-memory KV double recording every key that was read. */
function createKeyValueNamespace(entries: Record<string, string> = {}, failing = false): {
  namespace: KVNamespace;
  reads: string[];
} {
  const reads: string[] = [];
  const store = new Map(Object.entries(entries));
  const namespace = {
    get: async (key: string) => {
      reads.push(key);
      if (failing) {
        throw new Error('KV is down');
      }
      return store.get(key) ?? null;
    },
  };
  return { namespace: namespace as unknown as KVNamespace, reads };
}

describe('resolveCheckpointScope (the tenant boundary of the checkpoints)', () => {
  it('namespaces every key of a newscast under chk/{userUUID}/{newscastID}/', () => {
    const scope = resolveCheckpointScope(USER, NEWSCAST);
    expect(scope.prefix).toBe(`chk/${USER}/${NEWSCAST}/`);
    expect(scope.articles).toBe(`chk/${USER}/${NEWSCAST}/articles`);
    expect(scope.plan).toBe(`chk/${USER}/${NEWSCAST}/plan`);
    expect(scope.signal).toBe(`chk/${USER}/${NEWSCAST}/signal`);
    expect(scope.scriptPart(2)).toBe(`chk/${USER}/${NEWSCAST}/script/p2`);
    expect(scope.ttsPart(2)).toBe(`chk/${USER}/${NEWSCAST}/tts/p2`);
    expect(scope.mergedPart(2)).toBe(`chk/${USER}/${NEWSCAST}/part/p2`);
  });

  it('keeps two users apart even for the same newscast id', () => {
    expect(resolveCheckpointScope(USER, NEWSCAST).prefix).not.toBe(
      resolveCheckpointScope('22222222-2222-5222-8222-222222222222', NEWSCAST).prefix,
    );
  });
});

describe('readCheckpoint', () => {
  it('reads and parses the stored checkpoint', async () => {
    const scope = resolveCheckpointScope(USER, NEWSCAST);
    const { namespace, reads } = createKeyValueNamespace({ [scope.articles]: JSON.stringify([{ title: 'stored' }]) });

    expect(await readCheckpoint<Array<{ title: string }>>(namespace, scope.articles)).toEqual([{ title: 'stored' }]);
    expect(reads).toEqual([scope.articles]);
  });

  it('reports a miss for an absent or malformed payload rather than throwing', async () => {
    const scope = resolveCheckpointScope(USER, NEWSCAST);
    const { namespace } = createKeyValueNamespace({ [scope.plan]: '{broken' });

    expect(await readCheckpoint(namespace, scope.plan)).toBeNull();
    expect(await readCheckpoint(namespace, scope.mergedPart(3))).toBeNull();
  });

  it('reads a KV error as a miss, so a resume re-runs the stage instead of failing', async () => {
    const { namespace } = createKeyValueNamespace({}, true);

    expect(await readCheckpoint(namespace, resolveCheckpointScope(USER, NEWSCAST).signal)).toBeNull();
  });
});
