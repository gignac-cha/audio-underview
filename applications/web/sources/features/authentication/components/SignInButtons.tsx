import type { OAuthProviderID } from '@audio-underview/schemas';
import { toErrorMessage } from '../../../api/errors.ts';
import { useToasts } from '../../../state/toasts.ts';
import { buildAuthorizeURL, providerMetadata } from '../providers-metadata.ts';
import styles from './SignInButtons.module.css';

export interface SignInButtonsProps {
  providers: OAuthProviderID[];
}

/** 활성 provider별 로그인 버튼 — 클릭 시 authorize 엔드포인트로 리다이렉트. */
export const SignInButtons = ({ providers }: SignInButtonsProps) => {
  const { showError } = useToasts();

  const startSignIn = (provider: OAuthProviderID) => {
    try {
      window.location.assign(buildAuthorizeURL(provider));
    } catch (error) {
      showError('Sign-in unavailable', toErrorMessage(error));
    }
  };

  return (
    <div className={styles.list}>
      {providers.map((provider) => {
        const meta = providerMetadata[provider];
        return (
          <button
            key={provider}
            type="button"
            className={styles.button}
            onClick={() => {
              startSignIn(provider);
            }}
          >
            <span className={styles.monogram} style={{ backgroundColor: meta.accent }}>
              {meta.label.charAt(0)}
            </span>
            <span className={styles.label}>Continue with {meta.label}</span>
          </button>
        );
      })}
    </div>
  );
};
