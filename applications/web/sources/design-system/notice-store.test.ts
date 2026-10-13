import { clearNotices, dismissNotice, getNotices, showNotice } from './notice-store.ts';

describe('notice store', () => {
  afterEach(() => {
    clearNotices();
  });

  test('adds a notice with error tone by default', () => {
    const id = showNotice({ title: '로그인 실패', description: '로그인에 실패했습니다.' });

    expect(getNotices()).toEqual([{ id, tone: 'error', title: '로그인 실패', description: '로그인에 실패했습니다.' }]);
  });

  test('replaces an identical notice instead of stacking a copy', () => {
    const firstID = showNotice({ title: '로그인을 시작하지 못했습니다', description: '잠시 후 다시 시도해주세요.' });
    const secondID = showNotice({ title: '로그인을 시작하지 못했습니다', description: '잠시 후 다시 시도해주세요.' });

    expect(secondID).not.toBe(firstID);
    expect(getNotices().map((notice) => notice.id)).toEqual([secondID]);
  });

  test('keeps different notices side by side', () => {
    showNotice({ title: '세션이 만료되었습니다', description: '다시 로그인해주세요.' });
    showNotice({ title: '로그인 실패' });

    expect(getNotices().map((notice) => notice.title)).toEqual(['세션이 만료되었습니다', '로그인 실패']);
  });

  test('dismisses one notice by ID', () => {
    const keptID = showNotice({ title: '세션이 만료되었습니다' });
    const dismissedID = showNotice({ title: '로그인 실패' });

    dismissNotice(dismissedID);

    expect(getNotices().map((notice) => notice.id)).toEqual([keptID]);
  });

  test('clears every notice', () => {
    showNotice({ title: '세션이 만료되었습니다' });
    showNotice({ title: '로그인 실패' });

    clearNotices();

    expect(getNotices()).toEqual([]);
  });
});
