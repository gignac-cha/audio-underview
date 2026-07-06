import { OAuthFlowError } from '@audio-underview/authentication-core';
import { describe, expect, it } from 'vitest';
import { discordStrategy } from '../sources/providers/discord.ts';
import { facebookStrategy } from '../sources/providers/facebook.ts';
import { githubStrategy } from '../sources/providers/github.ts';
import { kakaoStrategy } from '../sources/providers/kakao.ts';
import { microsoftStrategy } from '../sources/providers/microsoft.ts';
import { naverStrategy } from '../sources/providers/naver.ts';
import { xStrategy } from '../sources/providers/x.ts';
import { providerStrategies } from '../sources/registry.ts';
import { testConfiguration } from './test-helpers.ts';

const parameters = {
  redirectURI: 'https://worker.example.com/providers/callback',
  state: 'state-1',
  nonce: 'nonce-1',
  codeChallenge: 'challenge-1',
};

describe('buildAuthorizationURL — 공통 필수 파라미터', () => {
  it.each(Object.values(providerStrategies).map((strategy) => [strategy.id, strategy] as const))(
    '%s: client_id/redirect_uri/state 포함',
    (_id, strategy) => {
      const url = strategy.buildAuthorizationURL(testConfiguration, parameters);
      expect(url.searchParams.get('client_id')).toBe(testConfiguration.clientID);
      expect(url.searchParams.get('redirect_uri')).toBe(parameters.redirectURI);
      expect(url.searchParams.get('state')).toBe(parameters.state);
    },
  );
});

describe('buildAuthorizationURL — provider별 특이점', () => {
  it('facebook: scope를 콤마로 join하고 nonce/PKCE를 싣지 않는다', () => {
    const url = facebookStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.get('scope')).toBe('email,public_profile');
    expect(url.searchParams.has('nonce')).toBe(false);
    expect(url.searchParams.has('code_challenge')).toBe(false);
  });

  it('kakao: scope를 콤마로 join한다', () => {
    const url = kakaoStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.get('scope')).toBe('profile_nickname,profile_image,account_email');
  });

  it('github: response_type 파라미터를 생략한다', () => {
    const url = githubStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.has('response_type')).toBe(false);
    expect(url.searchParams.get('scope')).toBe('user:email');
  });

  it('naver: scope 파라미터를 생략한다', () => {
    const url = naverStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('discord: prompt=consent를 싣는다', () => {
    const url = discordStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('x: code_challenge(S256)를 싣는다', () => {
    const url = xStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('x: codeChallenge가 없으면 invalid_request로 거부한다', () => {
    expect(() =>
      xStrategy.buildAuthorizationURL(testConfiguration, {
        redirectURI: parameters.redirectURI,
        state: parameters.state,
      }),
    ).toThrow(OAuthFlowError);
  });

  it('microsoft: tenant 기본값 common으로 endpoint를 치환한다', () => {
    const url = microsoftStrategy.buildAuthorizationURL(testConfiguration, parameters);
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
  });

  it('microsoft: configuration.tenant로 endpoint를 치환한다', () => {
    const url = microsoftStrategy.buildAuthorizationURL(
      { ...testConfiguration, tenant: 'tenant-id-1' },
      parameters,
    );
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/tenant-id-1/oauth2/v2.0/authorize',
    );
  });
});
