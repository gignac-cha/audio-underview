import type { OAuthProviderID } from '@audio-underview/schemas';
import { requireServiceURL } from '../../environment.ts';

export interface ProviderMetadata {
  label: string;
  /** 브랜드 계열 액센트 (버튼 좌측 모노그램 배경). */
  accent: string;
}

export const providerMetadata: Record<OAuthProviderID, ProviderMetadata> = {
  google: { label: 'Google', accent: '#4285f4' },
  apple: { label: 'Apple', accent: '#111111' },
  microsoft: { label: 'Microsoft', accent: '#00a4ef' },
  facebook: { label: 'Facebook', accent: '#1877f2' },
  github: { label: 'GitHub', accent: '#24292f' },
  discord: { label: 'Discord', accent: '#5865f2' },
  kakao: { label: 'Kakao', accent: '#fee500' },
  naver: { label: 'Naver', accent: '#03c75a' },
  linkedin: { label: 'LinkedIn', accent: '#0a66c2' },
  x: { label: 'X', accent: '#000000' },
};

/** `{AUTH}/providers/{provider}/authorize?redirect_uri={origin}/authentication/callback` */
export const buildAuthorizeURL = (provider: OAuthProviderID): string => {
  const baseURL = requireServiceURL('VITE_AUTHENTICATION_WORKER_URL');
  const url = new URL(`${baseURL}/providers/${provider}/authorize`);
  url.searchParams.set('redirect_uri', `${window.location.origin}/authentication/callback`);
  return url.toString();
};
