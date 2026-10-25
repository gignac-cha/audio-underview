/**
 * Newscasts — articles turned into two-host audio, made by the newscast task group of a scheduler.
 *
 * A thin shell over the newscast component kit: the newscast LIST is the single universe;
 * `selectedJobID` is the only mode for INSPECTION. Layout is a responsive hybrid — master-detail
 * (list rail + sticky detail pane) at ≥900px, accordion (detail inline under the selected row)
 * below.
 *
 * LISTENING is a separate, independent axis: `playingJobID` binds a done newscast to the floating
 * player bar docked at the bottom, so audio keeps playing while the user browses other newscasts or
 * watches progress. Selection never changes playback; only an explicit Play does.
 *
 * This page does not make newscasts: a schedule in Schedulers does, with a newscast stage. A newscast
 * appears in the list once its run has made it, and the list is read every 2s while any newscast is
 * running.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignOutAlt } from '@fortawesome/free-solid-svg-icons';

import { useAuthentication } from '../hooks/use-authentication.ts';
import { useMediaQuery } from '../hooks/use-media-query.ts';
import {
  audioURLForJobPart,
  signalAudioURLForJob,
  useNewscastJobDetail,
  useNewscastJobs,
} from '../hooks/use-newscast-jobs.ts';
import { NavigationLinks } from '../components/NavigationLinks.tsx';
import { Header, LogoutButton } from '../components/PageHeader.tsx';
import { NewscastDetail } from '../components/newscast/NewscastDetail.tsx';
import {
  NewscastFloatingPlayer,
  type NewscastFloatingPlayerHandle,
} from '../components/newscast/NewscastFloatingPlayer.tsx';
import { NewscastList } from '../components/newscast/NewscastList.tsx';

const DESKTOP_QUERY = '(min-width: 900px)';

const PageContainer = styled.div`
  min-height: 100vh;
  background: var(--bg-deep);
`;

const Main = styled.main<{ withPlayer: boolean }>`
  max-width: 96rem;
  margin: 0 auto;
  /* Extra bottom padding while the floating player bar is docked, so the last
     list rows and detail content never hide beneath it. */
  padding: 1.5rem 1.25rem
    ${(props) =>
      props.withPlayer ? 'calc(13rem + env(safe-area-inset-bottom))' : '4rem'};
`;

const Layout = styled.div<{ desktop: boolean }>`
  display: grid;
  gap: 1.25rem;
  align-items: start;
  grid-template-columns: ${(props) => (props.desktop ? 'minmax(24rem, 32rem) 1fr' : '1fr')};

  /* Grid items default to min-width auto (their content's intrinsic width),
     which lets one wide child push the whole page past the viewport and make
     mobile browsers load it zoomed out. Cap every column at its track size. */
  & > * {
    min-width: 0;
  }
`;

const Rail = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const DetailPane = styled.div`
  position: sticky;
  top: 1.25rem;
`;

const SectionHeading = styled.h2`
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
`;

export function NewscastPage() {
  const { logout } = useAuthentication();
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [selectedJobID, setSelectedJobID] = useState<string>();

  // Listening axis — independent from selection. `playingJobID` binds the
  // floating bar; `isAudioPlaying` mirrors the bar's <audio> state so the
  // detail hero button and list can reflect it.
  const [playingJobID, setPlayingJobID] = useState<string>();
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const playerRef = useRef<NewscastFloatingPlayerHandle>(null);

  const { jobs, isLoading: isJobsLoading, error: jobsError } = useNewscastJobs();
  const {
    status: selectedStatus,
    audioURL,
    isLoading: isDetailLoading,
    error: detailError,
  } = useNewscastJobDetail(selectedJobID);
  // The PLAYING newscast's data for the bar — same query key as the selection's
  // detail hook, so React Query dedupes; done newscasts are terminal (no reads).
  const { status: playingStatus, audioURL: playingAudioURL } =
    useNewscastJobDetail(playingJobID);

  // Shared wall-clock tick for relative times + the elapsed timer: every second
  // while anything is running, lazily (every 30s) otherwise.
  const anyRunning = jobs.some((job) => job.status === 'running');
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMilliseconds(Date.now()), anyRunning ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // Accordion semantics on mobile: tapping the selected row again collapses it.
  const handleSelect = (jobID: string) => {
    setSelectedJobID((current) => (!isDesktop && current === jobID ? undefined : jobID));
  };

  // Explicit Play is the ONLY thing that (re)binds the bar; pressing it on the
  // already-bound newscast toggles pause/resume instead of reloading.
  const handlePlayToggle = (jobID: string) => {
    if (playingJobID === jobID) {
      playerRef.current?.toggle();
    } else {
      setPlayingJobID(jobID);
    }
  };

  const handleClosePlayer = () => {
    setPlayingJobID(undefined);
    setIsAudioPlaying(false);
  };

  const handlePlayingChange = useCallback((playing: boolean) => {
    setIsAudioPlaying(playing);
  }, []);

  const selectedSummary = jobs.find((job) => job.id === selectedJobID);
  const detail =
    selectedJobID !== undefined ? (
      <NewscastDetail
        status={selectedStatus}
        summary={selectedSummary}
        audioURL={audioURL}
        isLoading={isDetailLoading}
        error={detailError}
        nowMilliseconds={nowMilliseconds}
        isPlayingThisJob={selectedJobID === playingJobID}
        isAudioPlaying={isAudioPlaying}
        onPlayToggle={() => handlePlayToggle(selectedJobID)}
      />
    ) : undefined;

  const playingSummary = jobs.find((job) => job.id === playingJobID);
  const playingResult =
    playingStatus?.status === 'done' ? playingStatus.result : undefined;
  const showFloatingPlayer =
    playingJobID !== undefined &&
    playingResult !== undefined &&
    playingAudioURL !== undefined;

  return (
    <PageContainer>
      <Header>
        <NavigationLinks />
        <LogoutButton onClick={logout}>
          <FontAwesomeIcon icon={faSignOutAlt} />
          <span>Sign Out</span>
        </LogoutButton>
      </Header>

      <Main withPlayer={showFloatingPlayer}>
        <Layout desktop={isDesktop}>
          <Rail>
            <SectionHeading>Newscasts</SectionHeading>
            <NewscastList
              jobs={jobs}
              isLoading={isJobsLoading}
              error={jobsError}
              selectedJobID={selectedJobID}
              playingJobID={playingJobID}
              nowMilliseconds={nowMilliseconds}
              onSelect={handleSelect}
              inlineDetail={isDesktop ? undefined : detail}
            />
          </Rail>
          {isDesktop && (
            <DetailPane>
              {detail ?? (
                <NewscastDetail isLoading={false} nowMilliseconds={nowMilliseconds} />
              )}
            </DetailPane>
          )}
        </Layout>
      </Main>

      {showFloatingPlayer && (
        <NewscastFloatingPlayer
          key={playingJobID}
          ref={playerRef}
          title={
            playingSummary?.title ?? playingResult.sources[0]?.title ?? 'Newscast'
          }
          result={playingResult}
          audioURL={playingAudioURL}
          audioURLForPart={(partIndex) => audioURLForJobPart(playingJobID, partIndex)}
          partTransitionAudioURL={
            // Only bind the between-parts sting when the newscast actually generated
            // one — absent for single-part newscasts and failed generations, in which
            // case the player advances between parts with no sound.
            playingStatus?.result?.signalAudioKey !== undefined
              ? signalAudioURLForJob(playingJobID)
              : undefined
          }
          onClose={handleClosePlayer}
          onJumpToJob={() => setSelectedJobID(playingJobID)}
          onPlayingChange={handlePlayingChange}
        />
      )}
    </PageContainer>
  );
}
