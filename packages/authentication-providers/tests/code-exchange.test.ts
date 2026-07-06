import { OAuthFlowError } from '@audio-underview/authentication-core';
import { describe, expect, it } from 'vitest';
import { facebookStrategy } from '../sources/providers/facebook.ts';
import { githubStrategy } from '../sources/providers/github.ts';
import { kakaoStrategy } from '../sources/providers/kakao.ts';
import { microsoftStrategy } from '../sources/providers/microsoft.ts';
import { naverStrategy } from '../sources/providers/naver.ts';
import { xStrategy } from '../sources/providers/x.ts';
import { createRecordingFetch, testConfiguration } from './test-helpers.ts';

const exchangeParameters = {
  code: 'code-1',
  redirectURI: 'https://worker.example.com/providers/callback',
};

const tokenPayload = { access_token: 'access-token-1', token_type: 'bearer', expires_in: 3600 };

const createTokenFetch = () => createRecordingFetch(() => ({ payload: tokenPayload }));

describe('exchangeCode — POST body 계열', () => {
  it('microsoft: tenant endpoint에 POST하고 code_verifier를 전달한다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    const tokens = await microsoftStrategy.exchangeCode(
      { ...testConfiguration, tenant: 'tenant-id-1' },
      { ...exchangeParameters, codeVerifier: 'verifier-1' },
      fetchImplementation,
    );

    expect(tokens.accessToken).toBe('access-token-1');
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe(
      'https://login.microsoftonline.com/tenant-id-1/oauth2/v2.0/token',
    );
    const body = new URLSearchParams(request?.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    expect(body.get('redirect_uri')).toBe(exchangeParameters.redirectURI);
    expect(body.get('code_verifier')).toBe('verifier-1');
  });

  it('github: JSON 응답을 요구하는 POST로 교환한다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    await githubStrategy.exchangeCode(testConfiguration, exchangeParameters, fetchImplementation);

    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url.href).toBe('https://github.com/login/oauth/access_token');
    expect(request?.headers.get('accept')).toBe('application/json');
    const body = new URLSearchParams(request?.body);
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
  });

  it('kakao: client_secret이 설정된 경우에만 포함한다', async () => {
    const withSecret = createTokenFetch();
    await kakaoStrategy.exchangeCode(testConfiguration, exchangeParameters, withSecret.fetchImplementation);
    expect(new URLSearchParams(withSecret.requests[0]?.body).get('client_secret')).toBe('secret-1');

    const withoutSecret = createTokenFetch();
    await kakaoStrategy.exchangeCode(
      { clientID: 'client-1' },
      exchangeParameters,
      withoutSecret.fetchImplementation,
    );
    expect(new URLSearchParams(withoutSecret.requests[0]?.body).has('client_secret')).toBe(false);
  });

  it('x: code_verifier와 client 자격 증명을 POST body에 싣는다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    await xStrategy.exchangeCode(
      testConfiguration,
      { ...exchangeParameters, codeVerifier: 'verifier-1' },
      fetchImplementation,
    );

    const request = requests[0];
    expect(request?.url.href).toBe('https://api.twitter.com/2/oauth2/token');
    const body = new URLSearchParams(request?.body);
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
  });

  it('x: codeVerifier가 없으면 invalid_request로 거부한다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    await expect(
      xStrategy.exchangeCode(testConfiguration, exchangeParameters, fetchImplementation),
    ).rejects.toMatchObject({ name: 'OAuthFlowError', errorCode: 'invalid_request' });
    expect(requests).toHaveLength(0);
  });
});

describe('exchangeCode — GET query 계열 (스펙 §6)', () => {
  it('facebook: GET query로 교환한다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    const tokens = await facebookStrategy.exchangeCode(
      testConfiguration,
      exchangeParameters,
      fetchImplementation,
    );

    expect(tokens.accessToken).toBe('access-token-1');
    const request = requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.body).toBeUndefined();
    expect(request?.url.origin).toBe('https://graph.facebook.com');
    expect(request?.url.pathname).toBe('/v22.0/oauth/access_token');
    expect(request?.url.searchParams.get('code')).toBe('code-1');
    expect(request?.url.searchParams.get('client_id')).toBe('client-1');
    expect(request?.url.searchParams.get('client_secret')).toBe('secret-1');
    expect(request?.url.searchParams.get('redirect_uri')).toBe(exchangeParameters.redirectURI);
  });

  it('naver: GET query로 교환한다', async () => {
    const { fetchImplementation, requests } = createTokenFetch();
    await naverStrategy.exchangeCode(testConfiguration, exchangeParameters, fetchImplementation);

    const request = requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.origin).toBe('https://nid.naver.com');
    expect(request?.url.pathname).toBe('/oauth2.0/token');
    expect(request?.url.searchParams.get('grant_type')).toBe('authorization_code');
    expect(request?.url.searchParams.get('code')).toBe('code-1');
    expect(request?.url.searchParams.get('client_secret')).toBe('secret-1');
  });

  it('token endpoint가 error body를 돌려주면 unauthorized로 거부한다', async () => {
    const { fetchImplementation } = createRecordingFetch(() => ({
      payload: { error: 'invalid_grant', error_description: 'code expired' },
    }));
    await expect(
      facebookStrategy.exchangeCode(testConfiguration, exchangeParameters, fetchImplementation),
    ).rejects.toThrow(OAuthFlowError);
  });
});
