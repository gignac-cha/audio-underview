import { describe as group, expect, it } from 'vitest';
import { describe } from './details.ts';

const plain = (html: string) => html.replace(/<\/?strong>/g, '');

group('describe', () => {
  it('states direct counts alone when nothing is reached indirectly', () => {
    expect(plain(describe(2, 2, 18, 18))).toBe('패키지 2개를 쓰고, 18곳에서 쓰입니다.');
  });

  it('adds the indirect totals only where they are larger', () => {
    expect(plain(describe(1, 3, 2, 2))).toBe('패키지 1개를 직접 쓰며 거쳐서 쓰는 것까지 3개이고, 2곳에서 쓰입니다.');
  });

  it('says so when there is nothing on a side', () => {
    expect(plain(describe(0, 0, 0, 0))).toBe('다른 패키지를 쓰지 않고, 이 패키지를 쓰는 곳은 없습니다.');
  });
});
