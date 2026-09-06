import { describe, expect, it } from 'vitest';
import { discordStrategy } from '../sources/providers/discord.ts';
import { facebookStrategy } from '../sources/providers/facebook.ts';
import { githubStrategy } from '../sources/providers/github.ts';
import { kakaoStrategy } from '../sources/providers/kakao.ts';
import { linkedinStrategy } from '../sources/providers/linkedin.ts';
import { naverStrategy } from '../sources/providers/naver.ts';
import { xStrategy } from '../sources/providers/x.ts';
import {
  createRecordingFetch,
  testConfiguration,
  testTokens,
  type FakeResponse,
} from './test-helpers.ts';

const fetchUserWith = async (
  strategy:
    | typeof facebookStrategy
     
     
     
     
     
     ,
  respond: (url: URL) => FakeResponse,
) => {
  const { fetchImplementation, requests } = createRecordingFetch(respond);
  const user = await strategy.fetchUser(testConfiguration, testTokens, { fetchImplementation });
  return { user, requests };
};

describe('facebook fetchUser', () => {
  it('Graph 응답을 파싱하고 access_token을 query로 보낸다', async () => {
    const { user, requests } = await fetchUserWith(facebookStrategy, () => ({
      payload: {
        id: 'facebook-user-1',
        name: 'Face Book',
        email: 'user@example.com',
        first_name: 'Face',
        last_name: 'Book',
        picture: { data: { url: 'https://cdn.example.com/picture.png' } },
      },
    }));

    expect(user).toEqual({
      id: 'facebook-user-1',
      email: 'user@example.com',
      name: 'Face Book',
      picture: 'https://cdn.example.com/picture.png',
      provider: 'facebook',
    });
    const request = requests[0];
    expect(request?.url.searchParams.get('access_token')).toBe('access-token-1');
    expect(request?.url.searchParams.get('fields')).toContain('email');
  });

  it('email/name이 없으면 fallback 체인을 적용한다', async () => {
    const { user } = await fetchUserWith(facebookStrategy, () => ({
      payload: { id: 'facebook-user-1', first_name: 'Face', last_name: 'Book' },
    }));
    expect(user.email).toBe('facebook-user-1@facebook.com');
    expect(user.name).toBe('Face Book');

    const { user: minimalUser } = await fetchUserWith(facebookStrategy, () => ({
      payload: { id: 'facebook-user-1' },
    }));
    expect(minimalUser.name).toBe('facebook-user-1');
  });
});

describe('github fetchUser', () => {
  it('숫자 id를 문자열로 정규화하고 프로필 email을 그대로 쓴다', async () => {
    const { user, requests } = await fetchUserWith(githubStrategy, () => ({
      payload: {
        id: 128,
        login: 'octocat',
        email: 'octo@example.com',
        name: 'Octo Cat',
        avatar_url: 'https://avatars.example.com/octocat.png',
      },
    }));

    expect(user).toEqual({
      id: '128',
      email: 'octo@example.com',
      name: 'Octo Cat',
      picture: 'https://avatars.example.com/octocat.png',
      provider: 'github',
    });
    // 프로필에 email이 있으면 /user/emails를 조회하지 않는다
    expect(requests).toHaveLength(1);
  });

  it('프로필에 email이 없으면 /user/emails에서 primary+verified를 고른다', async () => {
    const { user, requests } = await fetchUserWith(githubStrategy, (url) => {
      if (url.pathname === '/user/emails') {
        return {
          payload: [
            { email: 'secondary@example.com', primary: false, verified: true },
            { email: 'unverified@example.com', primary: true, verified: false },
            { email: 'primary@example.com', primary: true, verified: true },
          ],
        };
      }
      return { payload: { id: 128, login: 'octocat' } };
    });

    expect(user.email).toBe('primary@example.com');
    expect(user.name).toBe('octocat');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url.href).toBe('https://api.github.com/user/emails');
  });

  it('primary+verified email이 없으면 noreply fallback을 쓴다', async () => {
    const { user } = await fetchUserWith(githubStrategy, (url) =>
      url.pathname === '/user/emails'
        ? { payload: [] }
        : { payload: { id: 128, login: 'octocat' } },
    );
    expect(user.email).toBe('octocat@users.noreply.github.com');
  });
});

describe('discord fetchUser', () => {
  it('avatar hash로 CDN URL을 조립한다', async () => {
    const { user } = await fetchUserWith(discordStrategy, () => ({
      payload: {
        id: 'discord-user-1',
        username: 'discorduser',
        global_name: 'Discord User',
        avatar: 'avatar-hash-1',
        email: 'user@example.com',
      },
    }));

    expect(user).toEqual({
      id: 'discord-user-1',
      email: 'user@example.com',
      name: 'Discord User',
      picture: 'https://cdn.discordapp.com/avatars/discord-user-1/avatar-hash-1.png',
      provider: 'discord',
    });
  });

  it('global_name이 없으면 username을 쓰고 avatar가 없으면 picture를 생략한다', async () => {
    const { user } = await fetchUserWith(discordStrategy, () => ({
      payload: { id: 'discord-user-1', username: 'discorduser', email: 'user@example.com' },
    }));
    expect(user.name).toBe('discorduser');
    expect(user.picture).toBeUndefined();
  });

  it('email이 없으면 unauthorized로 거부한다 (requiresEmail)', async () => {
    const { fetchImplementation } = createRecordingFetch(() => ({
      payload: { id: 'discord-user-1', username: 'discorduser' },
    }));
    await expect(
      discordStrategy.fetchUser(testConfiguration, testTokens, { fetchImplementation }),
    ).rejects.toMatchObject({ name: 'OAuthFlowError', errorCode: 'unauthorized' });
  });
});

describe('kakao fetchUser', () => {
  it('중첩된 kakao_account를 파싱한다', async () => {
    const { user } = await fetchUserWith(kakaoStrategy, () => ({
      payload: {
        id: 42,
        kakao_account: {
          email: 'user@example.com',
          profile: {
            nickname: 'KakaoNick',
            profile_image_url: 'https://cdn.example.com/kakao.png',
          },
        },
      },
    }));

    expect(user).toEqual({
      id: '42',
      email: 'user@example.com',
      name: 'KakaoNick',
      picture: 'https://cdn.example.com/kakao.png',
      provider: 'kakao',
    });
  });

  it('properties nickname/profile_image로 fallback한다', async () => {
    const { user } = await fetchUserWith(kakaoStrategy, () => ({
      payload: {
        id: 42,
        properties: { nickname: 'PropsNick', profile_image: 'https://cdn.example.com/props.png' },
      },
    }));
    expect(user.name).toBe('PropsNick');
    expect(user.picture).toBe('https://cdn.example.com/props.png');
  });

  it('최소 응답이면 합성 email/name을 쓴다', async () => {
    const { user } = await fetchUserWith(kakaoStrategy, () => ({ payload: { id: 42 } }));
    expect(user.email).toBe('42@kakao.com');
    expect(user.name).toBe('KakaoUser42');
    expect(user.picture).toBeUndefined();
  });
});

describe('naver fetchUser', () => {
  it('wrapper 응답을 파싱한다', async () => {
    const { user } = await fetchUserWith(naverStrategy, () => ({
      payload: {
        resultcode: '00',
        message: 'success',
        response: {
          id: 'naver-user-1',
          email: 'user@example.com',
          name: 'Naver User',
          profile_image: 'https://cdn.example.com/naver.png',
        },
      },
    }));

    expect(user).toEqual({
      id: 'naver-user-1',
      email: 'user@example.com',
      name: 'Naver User',
      picture: 'https://cdn.example.com/naver.png',
      provider: 'naver',
    });
  });

  it('email이 없으면 null을 유지한다 (합성 금지)', async () => {
    const { user } = await fetchUserWith(naverStrategy, () => ({
      payload: {
        resultcode: '00',
        message: 'success',
        response: { id: 'naver-user-1', nickname: 'NaverNick' },
      },
    }));
    expect(user.email).toBeNull();
    expect(user.name).toBe('NaverNick');
  });

  it('resultcode가 00이 아니면 unauthorized로 거부한다', async () => {
    const { fetchImplementation } = createRecordingFetch(() => ({
      payload: { resultcode: '024', message: 'Authentication failed' },
    }));
    await expect(
      naverStrategy.fetchUser(testConfiguration, testTokens, { fetchImplementation }),
    ).rejects.toMatchObject({ name: 'OAuthFlowError', errorCode: 'unauthorized' });
  });
});

describe('linkedin fetchUser', () => {
  it('OIDC userinfo 응답을 파싱한다', async () => {
    const { user, requests } = await fetchUserWith(linkedinStrategy, () => ({
      payload: {
        sub: 'linkedin-user-1',
        email: 'user@example.com',
        name: 'LinkedIn User',
        picture: 'https://cdn.example.com/linkedin.png',
      },
    }));

    expect(user).toEqual({
      id: 'linkedin-user-1',
      email: 'user@example.com',
      name: 'LinkedIn User',
      picture: 'https://cdn.example.com/linkedin.png',
      provider: 'linkedin',
    });
    expect(requests[0]?.url.href).toBe('https://api.linkedin.com/v2/userinfo');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer access-token-1');
  });

  it('name이 없으면 given_name → sub 순으로 fallback한다', async () => {
    const { user } = await fetchUserWith(linkedinStrategy, () => ({
      payload: { sub: 'linkedin-user-1', given_name: 'Given' },
    }));
    expect(user.email).toBeNull();
    expect(user.name).toBe('Given');
  });
});

describe('x fetchUser', () => {
  it('data wrapper를 파싱하고 email은 항상 null이다', async () => {
    const { user } = await fetchUserWith(xStrategy, () => ({
      payload: {
        data: {
          id: 'x-user-1',
          username: 'xuser',
          name: 'X User',
          profile_image_url: 'https://cdn.example.com/x.png',
        },
      },
    }));

    expect(user).toEqual({
      id: 'x-user-1',
      email: null,
      name: 'X User',
      picture: 'https://cdn.example.com/x.png',
      provider: 'x',
    });
  });

  it('name이 없으면 username으로 fallback한다', async () => {
    const { user } = await fetchUserWith(xStrategy, () => ({
      payload: { data: { id: 'x-user-1', username: 'xuser' } },
    }));
    expect(user.name).toBe('xuser');
  });

  it('data wrapper가 없으면 unauthorized로 거부한다', async () => {
    const { fetchImplementation } = createRecordingFetch(() => ({ payload: { id: 'x-user-1' } }));
    await expect(
      xStrategy.fetchUser(testConfiguration, testTokens, { fetchImplementation }),
    ).rejects.toMatchObject({ name: 'OAuthFlowError', errorCode: 'unauthorized' });
  });
});
