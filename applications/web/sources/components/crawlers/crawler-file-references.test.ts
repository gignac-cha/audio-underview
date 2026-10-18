import { findFileReferences } from './crawler-file-references.ts';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';

function reference(fileID: string, overrides: Record<string, unknown> = {}) {
  return { file_id: fileID, content_type: 'text/plain', size: 12, name: 'notes.txt', ...overrides };
}

describe('findFileReferences', () => {
  test('finds nothing in a result without files', () => {
    expect(findFileReferences({ title: 'Hello', items: [1, 2, 3] })).toEqual([]);
    expect(findFileReferences(null)).toEqual([]);
    expect(findFileReferences('text')).toEqual([]);
    expect(findFileReferences(undefined)).toEqual([]);
  });

  test('finds a result that is a file reference itself', () => {
    expect(findFileReferences(reference(FIRST_ID))).toEqual([reference(FIRST_ID)]);
  });

  test('finds references inside objects and arrays at any depth, in the order they appear', () => {
    const result = {
      report: reference(FIRST_ID),
      pages: [{ screenshot: reference(SECOND_ID, { name: null }) }, [[reference(THIRD_ID)]]],
    };

    expect(findFileReferences(result).map((file) => file.file_id)).toEqual([FIRST_ID, SECOND_ID, THIRD_ID]);
  });

  test('keeps the type, size and name of a reference, and a name that is null', () => {
    const files = findFileReferences([reference(FIRST_ID, { content_type: 'image/png', size: 2048, name: null })]);

    expect(files).toEqual([{ file_id: FIRST_ID, content_type: 'image/png', size: 2048, name: null }]);
  });

  test('lists a file referenced more than once a single time', () => {
    const files = findFileReferences({ first: reference(FIRST_ID), again: reference(FIRST_ID), other: reference(SECOND_ID) });

    expect(files.map((file) => file.file_id)).toEqual([FIRST_ID, SECOND_ID]);
  });

  test('ignores an object whose file_id is not a UUID string', () => {
    expect(findFileReferences(reference('not-a-uuid'))).toEqual([]);
    expect(findFileReferences(reference(FIRST_ID.replace('4111', '411')))).toEqual([]);
    expect(findFileReferences({ ...reference(FIRST_ID), file_id: 42 })).toEqual([]);
  });

  test('ignores an object with a content_type, size or name of the wrong type', () => {
    expect(findFileReferences(reference(FIRST_ID, { content_type: 7 }))).toEqual([]);
    expect(findFileReferences(reference(FIRST_ID, { size: '12' }))).toEqual([]);
    expect(findFileReferences(reference(FIRST_ID, { name: 5 }))).toEqual([]);
    expect(findFileReferences(reference(FIRST_ID, { name: undefined }))).toEqual([]);
  });

  test('accepts an upper-case UUID', () => {
    const upperCaseID = FIRST_ID.toUpperCase();

    expect(findFileReferences(reference(upperCaseID)).map((file) => file.file_id)).toEqual([upperCaseID]);
  });

  test('stops at a result nested absurdly deep instead of overflowing the stack', () => {
    let nested: unknown = reference(FIRST_ID);
    for (let level = 0; level < 5000; level += 1) {
      nested = { child: nested };
    }

    expect(findFileReferences(nested)).toEqual([]);
  });
});
