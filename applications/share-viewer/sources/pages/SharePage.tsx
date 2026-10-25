/**
 * `/share/:token` — the only page that matters.
 *
 * Loading, valid, and invalid are the three states. The invalid screen is
 * reached both by a revoked link and by a token that never existed; the worker
 * refuses to distinguish them, and neither does this page.
 *
 * The document title is set client-side too, even though the Pages Function
 * already injected one: a client-side navigation (landing page to a share link)
 * never re-fetches the document.
 */

import { useEffect } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { useParams } from 'react-router';
import { SITE_NAME } from '../constants.ts';
import { ViewerHeader } from '../components/ViewerHeader.tsx';
import { NoticeScreen } from '../components/NoticeScreen.tsx';
import { SharedNewscastView } from '../components/SharedNewscastView.tsx';
import { useShareView } from '../hooks/use-share-view.ts';
import { sharePartAudioUrl, shareSignalAudioUrl } from '../hooks/share-api.ts';

/*
   The skeleton mirrors the real layout rather than showing three generic slabs
   (audit A10): hero card, title, byline, then transcript lines. Nothing moves
   sideways when the payload lands, which is the whole point of having one.
 */
const Skeleton = styled.main`
  max-width: 56rem;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 3rem;
  display: grid;
  gap: 1.25rem;
`;

const pulse = keyframes`
  0%, 100% { opacity: 0.55; }
  50% { opacity: 0.85; }
`;

const SkeletonBlock = styled.div<{ height: string; width?: string; radius?: string }>`
  height: ${(props) => props.height};
  width: ${(props) => props.width ?? '100%'};
  border-radius: ${(props) => props.radius ?? '14px'};
  background: ${(props) => props.theme.colours.surfaceAlternate};
  animation: ${pulse} 1.4s ease-in-out infinite;

  @media (prefers-reduced-motion: reduce) {
    animation: none;
    opacity: 0.7;
  }
`;

const SkeletonHeading = styled.div`
  display: grid;
  gap: 0.5rem;
`;

const SkeletonLines = styled.div`
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 14px;
  border: 1px solid ${(props) => props.theme.colours.border};
`;

/** Ragged widths, because a transcript is ragged and a ladder of equal bars is not. */
const SKELETON_LINE_WIDTHS = ['92%', '78%', '85%', '64%', '88%', '71%'];

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const state = useShareView(token);

  useEffect(() => {
    document.title =
      state.status === 'ready' ? `${state.view.title} — ${SITE_NAME}` : SITE_NAME;
  }, [state]);

  return (
    <>
      <ViewerHeader showShareBadge={true} />
      {state.status === 'loading' && (
        <Skeleton aria-busy="true" aria-label="불러오는 중">
          <SkeletonBlock height="9.5rem" radius="18px" data-testid="skeleton-hero" />
          <SkeletonHeading>
            <SkeletonBlock height="2.25rem" width="82%" radius="10px" />
            <SkeletonBlock height="1rem" width="58%" radius="6px" />
          </SkeletonHeading>
          <SkeletonLines data-testid="skeleton-lines">
            {SKELETON_LINE_WIDTHS.map((width) => (
              <SkeletonBlock key={width} height="1rem" width={width} radius="6px" />
            ))}
          </SkeletonLines>
        </Skeleton>
      )}
      {state.status === 'not-found' && (
        <NoticeScreen heading="이 링크는 더 이상 유효하지 않습니다">
          공유가 회수되었거나, 뉴스캐스트가 삭제되었거나, 주소가 잘못되었습니다.
        </NoticeScreen>
      )}
      {state.status === 'error' && (
        <NoticeScreen heading="지금은 불러올 수 없습니다">
          네트워크 문제로 공유된 뉴스캐스트를 가져오지 못했습니다. 잠시 후 다시
          시도해 주세요.
        </NoticeScreen>
      )}
      {/*
        The worker normalizes even a legacy single-audio job into one part, so an
        empty `parts` should be impossible — but the payload is server data the
        viewer does not control, and the player would dereference `parts[0]`.
      */}
      {state.status === 'ready' && state.view.parts.length === 0 && (
        <NoticeScreen heading="재생할 내용이 없습니다">
          이 공유 링크에 담긴 뉴스캐스트에서 오디오를 찾지 못했습니다.
        </NoticeScreen>
      )}
      {state.status === 'ready' && token !== undefined && state.view.parts.length > 0 && (
        <SharedNewscastView
          view={state.view}
          partAudioUrl={(partIndex) => sharePartAudioUrl(token, partIndex)}
          signalAudioUrl={shareSignalAudioUrl(token)}
        />
      )}
    </>
  );
}
