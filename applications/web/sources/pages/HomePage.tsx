import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import styled from '@emotion/styled';
import { css } from '@emotion/react';
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons';
import { PROVIDER_DISPLAY_CONFIGURATIONS, type OAuthUser } from '@audio-underview/sign-provider';
import { useAuthentication } from '../hooks/use-authentication.ts';
import { useLinkedAccounts, type LinkedAccountsState } from '../hooks/use-linked-accounts.ts';
import type { LinkedAccount } from '../schemas/linked-accounts.ts';
import { PageLayout } from '../design-system/components/PageLayout.tsx';
import { TopBar } from '../design-system/components/TopBar.tsx';
import { TopBarAccount } from '../design-system/components/TopBarAccount.tsx';
import { Button } from '../design-system/components/Button.tsx';
import { Icon } from '../design-system/components/Icon.tsx';
import { ProfileImage } from '../design-system/components/ProfileImage.tsx';
import { ProviderLogo } from '../design-system/components/ProviderLogo.tsx';
import { LoadingPlaceholder, Skeleton } from '../design-system/components/Skeleton.tsx';
import { showNotice } from '../design-system/notice-store.ts';
import {
  color,
  duration,
  easing,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  media,
  radius,
  size,
  space,
  textStyle,
} from '../design-system/tokens.ts';
import { focusRing, linkReset } from '../design-system/styles.ts';

const SERVICE_NAME = 'Audio Underview';
const HOME_PATH = '/home';
const SIGN_IN_PATH = '/sign/in';
const NAVIGATION_LABEL = '주 메뉴';

const NAVIGATION_ITEMS = [
  { label: '홈', path: '/home' },
  { label: '크롤러', path: '/crawlers' },
  { label: '스케줄러', path: '/schedulers' },
] as const;

const SHORTCUTS = [
  {
    title: '크롤러',
    description: '웹 페이지에서 필요한 내용을 뽑는 코드를 만들고 시험합니다',
    path: '/crawlers',
  },
  {
    title: '스케줄러',
    description: '크롤러를 순서대로 묶어 실행합니다',
    path: '/schedulers',
  },
] as const;

const TEXT = {
  signOut: '로그아웃',
  accountHeading: '계정',
  linkedAccountsHeading: '연결된 로그인',
  shortcutsHeading: '바로가기',
  linkedAccountsLoading: '연결된 로그인을 불러오는 중입니다',
  linkedAccountsEmpty: '연결된 로그인이 없습니다',
  linkedAccountsFailed: '연결된 로그인을 불러오지 못했습니다',
  retry: '다시 시도',
  sessionExpiredTitle: '세션이 만료되었습니다',
  sessionExpiredDescription: '다시 로그인해주세요.',
} as const;

function greeting(name: string): string {
  return `${name}님, 안녕하세요`;
}

function signedInWith(displayName: string): string {
  return `${displayName}로 로그인함`;
}

/** Lets a long address wrap before "@" instead of in the middle of the domain. */
function breakableEmail(email: string): ReactNode {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0) {
    return email;
  }
  return (
    <>
      {email.slice(0, atIndex)}
      <wbr />
      {email.slice(atIndex)}
    </>
  );
}

const linkedDateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });

/* Layout: one two-column grid from 768px. 계정 and 연결된 로그인 share a row,
   and the two shortcut cards sit below on the same two columns. Every panel
   uses the container radius. What sets them apart is the edge: the static
   연결된 로그인 list is one surface with a hairline border and row separators,
   while each shortcut card is its own box with the stronger control outline,
   like an outlined button. */

const Greeting = styled.h1`
  ${textStyle.heading1};
  color: ${color.ink};
  margin-block-end: ${space[6]};

  ${media.medium} {
    margin-block-end: ${space[7]};
  }
`;

const Sections = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
  row-gap: ${space[7]};

  ${media.medium} {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: ${space[6]};
  }

  ${media.large} {
    column-gap: ${space[7]};
  }
`;

const Section = styled.section`
  min-width: 0;
`;

const FullWidthSection = styled(Section)`
  grid-column: 1 / -1;
`;

const SectionHeading = styled.h2`
  ${textStyle.heading3};
  color: ${color.ink};
  margin-block-end: ${space[4]};
`;

/* 계정 */

const AccountSummary = styled.div`
  display: flex;
  align-items: center;
  gap: ${space[4]};

  ${media.medium} {
    gap: ${space[5]};
  }
`;

const AccountDetails = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${space[1]};
  min-width: 0;
`;

const AccountName = styled.p`
  ${textStyle.lead};
  font-weight: ${fontWeight.semibold};
  line-height: ${lineHeight.heading};
  color: ${color.ink};
`;

const AccountLine = styled.p`
  ${textStyle.body};
  line-height: ${lineHeight.compact};
  color: ${color.inkSecondary};
`;

const SignedInProvider = styled(AccountLine)`
  display: flex;
  align-items: center;
  gap: ${space[2]};
`;

/* Lists */

const listSurface = css`
  background-color: ${color.surface};
  border: ${size.borderWidth} solid ${color.line};
  border-radius: ${radius.container};
`;

/* Every list row, loaded or placeholder, is one list row tall, including its separator. */
const rowLayout = css`
  display: flex;
  align-items: center;
  gap: ${space[3]};
  min-height: ${size.listRow};
  padding: ${space[2]} ${space[4]};

  ${media.medium} {
    padding-inline: ${space[5]};
  }
`;

const separatedRows = css`
  & > * + * {
    border-top: ${size.borderWidth} solid ${color.line};
  }
`;

/* 연결된 로그인 */

/**
 * The surface is one list row tall. The placeholder, one login (the usual
 * case), the empty message, and the failure message with its 다시 시도 button
 * each fill exactly one row, so neither the surface nor the shortcuts below
 * move when the answer arrives. Two or more logins make it grow.
 */
const LinkedAccountsSurface = styled.div`
  ${listSurface};
  display: flex;
  flex-direction: column;
  min-height: calc(${size.listRow} + 2 * ${size.borderWidth});
`;

const LinkedAccountList = styled.ul`
  margin: 0;
  padding: 0;
  list-style: none;
  ${separatedRows};
`;

const LinkedAccountRow = styled.li`
  ${rowLayout};
`;

const SkeletonRow = styled.div`
  ${rowLayout};
`;

const ProviderMark = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  color: ${color.inkSecondary};
`;

/* Name and date differ in size, so they share a baseline instead of being centered separately. */
const RowText = styled.span`
  display: flex;
  flex: 1;
  align-items: baseline;
  justify-content: space-between;
  gap: ${space[3]};
  min-width: 0;
`;

const ProviderName = styled.span`
  ${textStyle.label};
  min-width: 0;
  color: ${color.ink};
`;

const LinkedDate = styled.time`
  ${textStyle.small};
  flex-shrink: 0;
  color: ${color.inkSecondary};
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`;

/* Placeholder bars sized like a provider name and a date, not like the whole row. */
const SkeletonText = styled.span`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: ${space[3]};
  min-width: 0;
`;

const SkeletonName = styled.span`
  flex: 0 1 ${space[9]};
  min-width: 0;
`;

const SkeletonDate = styled.span`
  flex: 0 0 ${space[8]};
`;

const EmptyRow = styled.p`
  ${rowLayout};
  flex: 1;
  color: ${color.inkSecondary};
`;

/**
 * The failure message and 다시 시도 share one row. Where the row is too narrow
 * for both on one line (below 1024px), the message wraps to two lines; two
 * lines at the heading line height are no taller than the button, so the row
 * stays one list row tall.
 */
const FailureRow = styled.div`
  ${rowLayout};
  flex: 1;
  justify-content: space-between;
`;

const FailureText = styled.p`
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: ${space[2]};
  min-width: 0;
  ${textStyle.label};
  line-height: ${lineHeight.heading};
  text-wrap: balance;
  color: ${color.danger};
`;

/* Keeps the icon centered on the first line when the message wraps. */
const FailureIcon = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  height: calc(${fontSize.body} * ${lineHeight.heading});
`;

/* The button keeps its full width and 44px height; the message wraps instead. */
const RetryButton = styled(Button)`
  flex-shrink: 0;
`;

/* 바로가기 */

/** Two cards, stacked on phones and side by side on the page's two columns from 768px. */
const ShortcutCards = styled.ul`
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: ${space[3]};
  margin: 0;
  padding: 0;
  list-style: none;

  ${media.medium} {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: ${space[6]};
  }

  ${media.large} {
    column-gap: ${space[7]};
  }
`;

const ShortcutItem = styled.li`
  display: flex;
  min-width: 0;
`;

/**
 * The whole card is one link. At rest it already reads as pressable: its own
 * box with the control outline (`lineStrong`, 3:1) and a teal title. Hover
 * fills it and darkens the outline, as on an outlined button, and underlines
 * the title; pressing fills it one step darker; keyboard focus draws the ring.
 */
const ShortcutCard = styled(Link)`
  ${linkReset};
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: ${space[1]};
  min-width: 0;
  padding: ${space[4]};
  background-color: ${color.surface};
  border: ${size.borderWidth} solid ${color.lineStrong};
  border-radius: ${radius.container};
  color: ${color.ink};
  -webkit-tap-highlight-color: transparent;
  transition:
    background-color ${duration.quick} ${easing.standard},
    border-color ${duration.quick} ${easing.standard};

  ${focusRing};

  ${media.medium} {
    padding: ${space[5]};
  }

  &:hover {
    color: ${color.ink};
    /* linkReset clears border-bottom on hover for inline links; a card keeps its full border */
    border-bottom: ${size.borderWidth} solid ${color.lineStrong};
  }

  ${media.hover} {
    &:hover {
      background-color: ${color.surfaceHover};
      border-color: ${color.ink};
    }

    &:hover h3 {
      text-decoration-line: underline;
    }
  }

  &:active {
    background-color: ${color.surfacePressed};
    border-color: ${color.ink};
  }

  ${media.forcedColors} {
    border-color: LinkText;
  }
`;

const ShortcutTitle = styled.h3`
  ${textStyle.lead};
  font-weight: ${fontWeight.semibold};
  line-height: ${lineHeight.heading};
  letter-spacing: ${letterSpacing.heading};
  color: ${color.accent};
  text-decoration-thickness: ${size.borderWidth};
  text-underline-offset: 0.2em;

  ${media.forcedColors} {
    color: LinkText;
  }
`;

const ShortcutDescription = styled.p`
  ${textStyle.body};
  color: ${color.inkSecondary};
`;

function AccountSection({ user }: { user: OAuthUser }) {
  const headingID = useId();
  const displayName = PROVIDER_DISPLAY_CONFIGURATIONS[user.provider].displayName;
  const email = user.email ?? undefined;

  return (
    <Section aria-labelledby={headingID}>
      <SectionHeading id={headingID}>{TEXT.accountHeading}</SectionHeading>
      <AccountSummary>
        <ProfileImage name={user.name} pictureURL={user.picture} size="large" />
        <AccountDetails>
          <AccountName>{user.name}</AccountName>
          {email !== undefined && email !== '' && <AccountLine>{breakableEmail(email)}</AccountLine>}
          <SignedInProvider>
            <ProviderLogo provider={user.provider} />
            <span>{signedInWith(displayName)}</span>
          </SignedInProvider>
        </AccountDetails>
      </AccountSummary>
    </Section>
  );
}

function LinkedAccountItem({ account }: { account: LinkedAccount }) {
  return (
    <LinkedAccountRow>
      <ProviderMark>
        <ProviderLogo provider={account.provider} />
      </ProviderMark>
      <RowText>
        <ProviderName>{PROVIDER_DISPLAY_CONFIGURATIONS[account.provider].displayName}</ProviderName>
        {account.linkedAt !== null && (
          <LinkedDate dateTime={account.linkedAt}>{linkedDateFormat.format(new Date(account.linkedAt))}</LinkedDate>
        )}
      </RowText>
    </LinkedAccountRow>
  );
}

function LinkedAccountsContent({ state, onRetry }: { state: LinkedAccountsState; onRetry: () => void }) {
  switch (state.status) {
    case 'listed':
      if (state.accounts.length === 0) {
        return <EmptyRow>{TEXT.linkedAccountsEmpty}</EmptyRow>;
      }
      return (
        <LinkedAccountList>
          {state.accounts.map((account) => (
            <LinkedAccountItem key={account.provider} account={account} />
          ))}
        </LinkedAccountList>
      );
    case 'failed':
      return (
        <FailureRow>
          <FailureText role="alert">
            <FailureIcon>
              <Icon icon={faCircleExclamation} />
            </FailureIcon>
            <span>{TEXT.linkedAccountsFailed}</span>
          </FailureText>
          <RetryButton variant="secondary" onClick={onRetry}>
            {TEXT.retry}
          </RetryButton>
        </FailureRow>
      );
    case 'loading':
    case 'unauthorized':
      return (
        <LoadingPlaceholder label={TEXT.linkedAccountsLoading}>
          <SkeletonRow>
            <Skeleton shape="circle" height={size.iconRegular} />
            <SkeletonText>
              <SkeletonName>
                <Skeleton textSize="small" />
              </SkeletonName>
              <SkeletonDate>
                <Skeleton textSize="small" />
              </SkeletonDate>
            </SkeletonText>
          </SkeletonRow>
        </LoadingPlaceholder>
      );
  }
}

function LinkedAccountsSection({ state, onRetry }: { state: LinkedAccountsState; onRetry: () => void }) {
  const headingID = useId();

  return (
    <Section aria-labelledby={headingID}>
      <SectionHeading id={headingID}>{TEXT.linkedAccountsHeading}</SectionHeading>
      <LinkedAccountsSurface>
        <LinkedAccountsContent state={state} onRetry={onRetry} />
      </LinkedAccountsSurface>
    </Section>
  );
}

function ShortcutsSection() {
  const headingID = useId();

  return (
    <FullWidthSection aria-labelledby={headingID}>
      <SectionHeading id={headingID}>{TEXT.shortcutsHeading}</SectionHeading>
      <ShortcutCards>
        {SHORTCUTS.map((shortcut) => (
          <ShortcutItem key={shortcut.path}>
            <ShortcutCard to={shortcut.path}>
              <ShortcutTitle>{shortcut.title}</ShortcutTitle>
              <ShortcutDescription>{shortcut.description}</ShortcutDescription>
            </ShortcutCard>
          </ShortcutItem>
        ))}
      </ShortcutCards>
    </FullWidthSection>
  );
}

export function HomePage() {
  const { user, logout } = useAuthentication();
  const navigate = useNavigate();
  const { state: linkedAccountsState, retry } = useLinkedAccounts(user);
  const handledSessionExpiryRef = useRef(false);

  useEffect(() => {
    if (linkedAccountsState.status !== 'unauthorized' || handledSessionExpiryRef.current) {
      return;
    }
    handledSessionExpiryRef.current = true;
    showNotice({ title: TEXT.sessionExpiredTitle, description: TEXT.sessionExpiredDescription });
    logout();
    navigate(SIGN_IN_PATH, { replace: true });
  }, [linkedAccountsState.status, logout, navigate]);

  if (user === undefined) {
    return null;
  }

  const signOut = () => {
    logout();
    navigate(SIGN_IN_PATH, { replace: true });
  };

  return (
    <PageLayout
      header={
        <TopBar
          serviceName={SERVICE_NAME}
          homePath={HOME_PATH}
          navigationLabel={NAVIGATION_LABEL}
          navigationItems={NAVIGATION_ITEMS}
          trailing={
            <TopBarAccount name={user.name} pictureURL={user.picture} signOutLabel={TEXT.signOut} onSignOut={signOut} />
          }
        />
      }
    >
      <Greeting>{greeting(user.name)}</Greeting>
      <Sections>
        <AccountSection user={user} />
        <LinkedAccountsSection state={linkedAccountsState} onRetry={retry} />
        <ShortcutsSection />
      </Sections>
    </PageLayout>
  );
}
