import { Navigate } from 'react-router';
import styled from '@emotion/styled';
import { PROVIDER_DISPLAY_CONFIGURATIONS, type OAuthProviderID } from '@audio-underview/sign-provider';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { AVAILABLE_PROVIDERS, PREPARING_PROVIDERS } from '../constants/provider-statuses.ts';
import { PageLayout } from '../design-system/components/PageLayout.tsx';
import { Button } from '../design-system/components/Button.tsx';
import { ProviderLogo } from '../design-system/components/ProviderLogo.tsx';
import { VisuallyHidden } from '../design-system/components/VisuallyHidden.tsx';
import { showNotice } from '../design-system/notice-store.ts';
import { color, layout, media, size, space, textStyle } from '../design-system/tokens.ts';

const SERVICE_NAME = 'Audio Underview';
const INTRODUCTION = '웹에서 모은 소식을 오디오 뉴스캐스트로 듣습니다';
const PREPARING_HEADING = '준비 중인 로그인';
const PREPARING_LABEL = '준비 중';
const PREPARING_HEADING_ID = 'preparing-sign-in-heading';
const START_FAILURE_NOTICE = {
  title: '로그인을 시작하지 못했습니다',
  description: '잠시 후 다시 시도해주세요.',
} as const;

function continueLabel(providerID: OAuthProviderID): string {
  return `${PROVIDER_DISPLAY_CONFIGURATIONS[providerID].displayName}로 계속하기`;
}

/**
 * One column on phones. From `medium` up, the service name and the sign-in
 * list sit side by side with their top edges aligned. The name gets the wider
 * share, so the introduction stays on one line at 768px and the buttons do not
 * stretch past their labels on wide screens. The page layout centers the whole
 * arrangement vertically, so it reads as one band across the middle rather
 * than a cluster at the top.
 */
const Arrangement = styled.div`
  display: grid;
  row-gap: ${space[7]};
  align-items: start;

  ${media.medium} {
    grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
    column-gap: ${space[7]};
  }

  ${media.large} {
    column-gap: ${space[8]};
  }
`;

const Introduction = styled.div`
  display: grid;
  row-gap: ${space[4]};

  ${media.medium} {
    row-gap: ${space[5]};
  }
`;

/**
 * The one loud element on the screen. `min-content` stacks the two words into
 * a wordmark at every width; `overflow-wrap: normal` keeps each word whole
 * while the layout measures that width. Trimming the top of the text box to
 * the cap height lines the letters up with the top of the first button.
 */
const ServiceName = styled.h1`
  ${textStyle.display};
  width: min-content;
  overflow-wrap: normal;
  color: ${color.ink};
  text-box: trim-start cap alphabetic;
`;

const Tagline = styled.p`
  ${textStyle.lead};
  max-width: ${layout.readingMaxWidth};
  color: ${color.inkSecondary};
`;

const SignInColumn = styled.div`
  display: grid;
  row-gap: ${space[6]};

  ${media.medium} {
    row-gap: ${space[7]};
  }
`;

const AvailableList = styled.ul`
  display: grid;
  row-gap: ${space[3]};
  padding: 0;
  list-style: none;
`;

const PreparingSection = styled.section`
  display: grid;
  row-gap: ${space[4]};
`;

const PreparingHeading = styled.h2`
  ${textStyle.label};
  padding-block-end: ${space[3]};
  border-block-end: ${size.borderWidth} solid ${color.line};
  color: ${color.inkSecondary};
`;

/** Plain text, not boxes: nothing here looks pressable, and muted ink keeps it behind the buttons. */
const PreparingList = styled.ul`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: ${space[3]} ${space[4]};
  padding: 0;
  list-style: none;
  color: ${color.inkMuted};

  ${media.extraLarge} {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
`;

/** One step smaller than the button labels, so the list stays behind the two actions. */
const PreparingItem = styled.li`
  display: flex;
  align-items: center;
  gap: ${space[2]};
  min-width: 0;
  ${textStyle.small};
`;

export function SignInPage() {
  const { isAuthenticated, isGoogleConfigured, isGitHubConfigured, loginWithGoogle, loginWithGitHub } =
    useAuthentication();

  if (isAuthenticated) {
    return <Navigate to="/home" replace />;
  }

  const starters: Partial<Record<OAuthProviderID, { isConfigured: boolean; start: () => void }>> = {
    google: { isConfigured: isGoogleConfigured, start: loginWithGoogle },
    github: { isConfigured: isGitHubConfigured, start: loginWithGitHub },
  };

  const startSignIn = (providerID: OAuthProviderID) => {
    const starter = starters[providerID];
    if (starter === undefined || !starter.isConfigured) {
      showNotice(START_FAILURE_NOTICE);
      return;
    }
    starter.start();
  };

  return (
    <PageLayout arrangement="vertically-centered">
      <Arrangement>
        <Introduction>
          <ServiceName>{SERVICE_NAME}</ServiceName>
          <Tagline>{INTRODUCTION}</Tagline>
        </Introduction>

        <SignInColumn>
          <AvailableList>
            {AVAILABLE_PROVIDERS.map((providerID) => (
              <li key={providerID}>
                <Button
                  variant="primary"
                  size="large"
                  fullWidth
                  leading={<ProviderLogo provider={providerID} size="large" />}
                  onClick={() => startSignIn(providerID)}
                >
                  {continueLabel(providerID)}
                </Button>
              </li>
            ))}
          </AvailableList>

          <PreparingSection aria-labelledby={PREPARING_HEADING_ID}>
            <PreparingHeading id={PREPARING_HEADING_ID}>{PREPARING_HEADING}</PreparingHeading>
            <PreparingList>
              {PREPARING_PROVIDERS.map((providerID) => (
                <PreparingItem key={providerID}>
                  <ProviderLogo provider={providerID} />
                  <span>{PROVIDER_DISPLAY_CONFIGURATIONS[providerID].displayName}</span>
                  <VisuallyHidden>{` ${PREPARING_LABEL}`}</VisuallyHidden>
                </PreparingItem>
              ))}
            </PreparingList>
          </PreparingSection>
        </SignInColumn>
      </Arrangement>
    </PageLayout>
  );
}
