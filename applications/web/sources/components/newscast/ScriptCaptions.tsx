/**
 * Shared caption rendering for newscast playback — the word-spotlight line view
 * and the full-script modal dialog. Extracted from the old inline player so the
 * floating player bar and the full-script dialog render dialogue lines through
 * one implementation (same highlight, same seek behavior).
 */

import { useEffect, useRef } from 'react';
import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type {
  AudioSegment,
  NewscastPart,
  ScriptLine,
  SpeakerId,
} from '@audio-underview/newscast-core';

export const SPEAKER_LABELS: Record<SpeakerId, string> = {
  1: 'Host 1',
  2: 'Host 2',
};

/**
 * Caption spotlight brightness levels (1 = dimmest … 6 = brightest) mapped to
 * opacity. Level 6 (the word being spoken) additionally gets bold weight and
 * the accent color.
 */
const WORD_LEVEL_OPACITY: Record<number, number> = {
  1: 0.2,
  2: 0.38,
  3: 0.52,
  4: 0.66,
  5: 0.82,
  6: 1,
};

/**
 * Brightness level for a current-line word by its distance from the spoken
 * word: d0 → 6 (spoken), d1 → 5, d2 → 4, d3 → 3, farther → 2. Non-current
 * lines render uniformly at level 1 (handled at the call site).
 */
function wordLevelForDistance(distance: number): number {
  if (distance === 0) {
    return 6;
  }
  if (distance === 1) {
    return 5;
  }
  if (distance === 2) {
    return 4;
  }
  if (distance === 3) {
    return 3;
  }
  return 2;
}

const CaptionLine = styled.div<{ active: boolean; dimmed?: boolean; clickable: boolean }>`
  display: flex;
  gap: 0.625rem;
  align-items: baseline;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  cursor: ${(props) => (props.clickable ? 'pointer' : 'default')};
  background: ${(props) => (props.active ? 'var(--accent-muted)' : 'transparent')};
  opacity: ${(props) => (props.dimmed === true ? 0.45 : 1)};
  transition: var(--transition-fast);

  &:hover {
    background: ${(props) => (props.clickable ? 'var(--accent-muted)' : 'transparent')};
  }
`;

export const SpeakerTag = styled.span<{ speaker: SpeakerId }>`
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-weight: 700;
  color: ${(props) =>
    props.speaker === 1 ? 'var(--accent-primary)' : 'var(--accent-secondary)'};
`;

const CaptionText = styled.span<{ active: boolean; emphasis: boolean }>`
  font-size: ${(props) => (props.emphasis ? '0.9375rem' : '0.875rem')};
  line-height: 1.7;
  color: ${(props) => (props.active ? 'var(--text-primary)' : 'var(--text-secondary)')};
`;

const WordSpan = styled.span<{ level: number; clickable: boolean }>`
  opacity: ${(props) => WORD_LEVEL_OPACITY[props.level] ?? 1};
  font-weight: ${(props) => (props.level === 6 ? 700 : 400)};
  color: ${(props) => (props.level === 6 ? 'var(--accent-primary)' : 'inherit')};
  transition: opacity 0.15s ease;
  cursor: ${(props) => (props.clickable ? 'pointer' : 'inherit')};
`;

export interface CaptionLineViewProps {
  line: ScriptLine;
  index: number;
  /** The audio is currently inside this line's segment. */
  active: boolean;
  /** This is the focus line (the spoken one, or the first before playback). */
  isCurrent: boolean;
  /** Per-word timings for THIS line's segment, when available. */
  segmentWords?: AudioSegment['words'];
  /** Index of the word being spoken within the focus line, or -1. */
  activeWordIndex: number;
  /** True when the whole result carries word timings (spotlight mode). */
  wordTracked: boolean;
  dimmed?: boolean;
  /** Slightly larger caption text (the floating bar's current line). */
  emphasis?: boolean;
  /** Line-level seek; omit to render a non-interactive, non-clickable line (preview mode). */
  onLineClick?: (index: number) => void;
  /** Word-level seek; omit to render words as passive text (e.g. the bar). */
  onWordClick?: (event: React.MouseEvent, startMs: number) => void;
  /** Ref to the rendered line element (dialog auto-scroll target). */
  lineRef?: React.Ref<HTMLDivElement>;
}

/** One caption line with the word spotlight, shared by the bar and the dialog. */
export function CaptionLineView({
  line,
  index,
  active,
  isCurrent,
  segmentWords,
  activeWordIndex,
  wordTracked,
  dimmed,
  emphasis = false,
  onLineClick,
  onWordClick,
  lineRef,
}: CaptionLineViewProps) {
  const clickable = onLineClick !== undefined;
  return (
    <CaptionLine
      ref={lineRef}
      active={active}
      dimmed={dimmed}
      clickable={clickable}
      onClick={clickable ? () => onLineClick(index) : undefined}
    >
      <SpeakerTag speaker={line.speaker}>{SPEAKER_LABELS[line.speaker]}</SpeakerTag>
      <CaptionText active={active} emphasis={emphasis}>
        {wordTracked && isCurrent && segmentWords !== undefined ? (
          segmentWords.map((word, wordIndex) => {
            const level =
              activeWordIndex < 0
                ? 2
                : wordLevelForDistance(Math.abs(wordIndex - activeWordIndex));
            return (
              <WordSpan
                key={wordIndex}
                level={level}
                clickable={onWordClick !== undefined}
                onClick={
                  onWordClick !== undefined
                    ? (event) => onWordClick(event, word.startMs)
                    : undefined
                }
              >
                {word.text}
                {wordIndex < segmentWords.length - 1 ? ' ' : ''}
              </WordSpan>
            );
          })
        ) : wordTracked ? (
          <WordSpan level={1} clickable={false}>
            {line.text}
          </WordSpan>
        ) : (
          line.text
        )}
      </CaptionText>
    </CaptionLine>
  );
}

const Overlay = styled(Dialog.Overlay)`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 100;
`;

const Content = styled(Dialog.Content)`
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 101;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.25rem;
  width: 92vw;
  max-width: 42rem;
  max-height: 80vh;
  box-shadow: var(--shadow-md);
`;

const DialogHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
`;

const DialogTitle = styled(Dialog.Title)`
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
`;

const CloseButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border-radius: 8px;

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const ScriptScroller = styled.div`
  overflow-y: auto;
  min-height: 0;
  padding-right: 0.25rem;
`;

const CaptionList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
`;

/** One part's block inside the multi-part full script (header + its lines). */
const PartGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.375rem;

  & + & {
    margin-top: 0.875rem;
  }
`;

/** The `— Part N —` separator between parts in the multi-part full script. */
const PartDivider = styled.div`
  padding: 0.375rem 0.75rem;
  font-size: 0.6875rem;
  font-weight: 700;
  font-family: var(--font-mono);
  letter-spacing: 0.04em;
  color: var(--text-muted);
`;

export interface FullScriptDialogProps {
  lines: ScriptLine[];
  segments: AudioSegment[];
  activeIndex: number;
  activeWordIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit in {@link preview} mode — no line is ever seekable there. */
  onSeekLine?: (index: number) => void;
  /** Omit in {@link preview} mode — no word is ever seekable there. */
  onSeekWord?: (event: React.MouseEvent, startMs: number) => void;
  /**
   * All parts of a multi-part newscast. When present with length > 1 the dialog
   * renders EVERY part under a `— Part N —` header (not just the bound part); a
   * line click inside another part switches to it via {@link onSeekPartLine}. Omit
   * (or a single part) → the classic single-part rendering driven by `lines`.
   */
  parts?: NewscastPart[];
  /** 0-based index into `parts` of the part currently bound to the audio. */
  currentPartIndex?: number;
  /** Seek to a line in ANOTHER part: the player switches parts, then seeks. */
  onSeekPartLine?: (partIndex: number, lineIndex: number) => void;
  /**
   * Read-only mode: the script is shown for reading before playback exists (no
   * bound newscast on the player yet). Disables the active-line highlight, the
   * word spotlight, and every click-to-seek affordance (line and word); a
   * multi-part script still groups by `— Part N —` but gives no part "current"
   * treatment.
   */
  preview?: boolean;
}

/**
 * The FULL script in a modal dialog with its own scroll — captions keep
 * highlighting while the audio plays, and it auto-scrolls to the line being
 * spoken when opened. Controlled: callers own the `open` state and their own
 * trigger buttons.
 */
export function FullScriptDialog({
  lines,
  segments,
  activeIndex,
  activeWordIndex,
  open,
  onOpenChange,
  onSeekLine,
  onSeekWord,
  parts,
  currentPartIndex = 0,
  onSeekPartLine,
  preview = false,
}: FullScriptDialogProps) {
  const activeLineRef = useRef<HTMLDivElement>(null);

  // `segments` is always the CURRENT part's timing, so the focus line + word
  // spotlight below are computed against the bound part in both modes.
  // Focus = the spoken line, or the first line before playback starts.
  // `preview` forces this false: no word is ever spotlit before playback exists.
  const focusIndex = activeIndex >= 0 ? activeIndex : 0;
  const focusWords = segments[focusIndex]?.words;
  const wordTracked = !preview && focusWords !== undefined && focusWords.length > 0;
  const isMultiPart = parts !== undefined && parts.length > 1;

  // When the dialog opens (and after switching parts), bring the spoken line of
  // the current part into view.
  useEffect(() => {
    if (open) {
      activeLineRef.current?.scrollIntoView({ block: 'center' });
    }
  }, [open, currentPartIndex]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Full script</DialogTitle>
            <Dialog.Close asChild>
              <CloseButton type="button">
                <FontAwesomeIcon icon={faXmark} aria-hidden={true} />
                Close
              </CloseButton>
            </Dialog.Close>
          </DialogHeader>
          <ScriptScroller>
            {isMultiPart ? (
              parts.map((part, partArrayIndex) => {
                // `preview` gives no part "current" treatment: no active line, no
                // word spotlight, and no click-to-seek anywhere in the script.
                const isCurrentPart = !preview && partArrayIndex === currentPartIndex;
                return (
                  <PartGroup key={part.index}>
                    <PartDivider>— Part {part.index} —</PartDivider>
                    <CaptionList>
                      {part.script.map((line, lineIndex) => {
                        const isFocus = isCurrentPart && lineIndex === focusIndex;
                        return (
                          <CaptionLineView
                            key={lineIndex}
                            line={line}
                            index={lineIndex}
                            active={isCurrentPart && lineIndex === activeIndex}
                            isCurrent={isFocus}
                            // Only the bound part carries live word timings; other
                            // parts render as plain, clickable seek targets.
                            segmentWords={
                              isCurrentPart ? part.segments[lineIndex]?.words : undefined
                            }
                            activeWordIndex={activeWordIndex}
                            wordTracked={isCurrentPart && wordTracked}
                            onLineClick={
                              preview
                                ? undefined
                                : isCurrentPart
                                  ? onSeekLine
                                  : (clickedIndex) =>
                                      onSeekPartLine?.(partArrayIndex, clickedIndex)
                            }
                            onWordClick={isCurrentPart ? onSeekWord : undefined}
                            lineRef={isFocus ? activeLineRef : undefined}
                          />
                        );
                      })}
                    </CaptionList>
                  </PartGroup>
                );
              })
            ) : (
              <CaptionList>
                {lines.map((line, index) => (
                  <CaptionLineView
                    key={index}
                    line={line}
                    index={index}
                    active={!preview && index === activeIndex}
                    isCurrent={!preview && index === focusIndex}
                    segmentWords={preview ? undefined : segments[index]?.words}
                    activeWordIndex={activeWordIndex}
                    wordTracked={wordTracked}
                    onLineClick={preview ? undefined : onSeekLine}
                    onWordClick={preview ? undefined : onSeekWord}
                    lineRef={!preview && index === focusIndex ? activeLineRef : undefined}
                  />
                ))}
              </CaptionList>
            )}
          </ScriptScroller>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
