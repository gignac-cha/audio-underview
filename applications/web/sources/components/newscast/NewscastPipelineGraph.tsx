/**
 * Read-only node graph of ONE newscast's pipeline run.
 *
 * The shape of the graph is DERIVED ENTIRELY from the `JobStatus` the page
 * already reads — stage / status / details / result. Nothing is fetched and no
 * worker or core contract changes: a pasted newscast renders its crawl nodes as
 * skipped, a three-part newscast renders three parallel script→tts→merge lanes,
 * and the transition sting appears only when it was actually generated.
 *
 * The flow runs TOP→BOTTOM: stage depth is the Y axis (source crawl → organize →
 * script → tts → merge → finalize) and the parallel part lanes (plus the sting)
 * spread along X. Phones are tall and narrow, so the axis the run grows along has
 * to be the tall one, and the handful of lanes then fit across the width instead
 * of demanding a pan. One orientation everywhere: a desktop/mobile branch would be
 * two layouts to keep in sync for no gain, since the vertical form reads fine on a
 * wide screen too.
 *
 * Rendering is the React-idiomatic D3 hybrid:
 *   - React owns the DOM. One `<svg>`; every node is a `<g><rect><text></g>`
 *     rendered declaratively. There is no d3 enter/update join anywhere, because
 *     two libraries writing the same subtree is how these hybrids break.
 *   - d3 owns the math. `d3.linkVertical()` generates the edge curves (a
 *     vertically-tangent cubic, so an edge leaves a node's bottom edge and
 *     arrives at the next one's top edge), and `d3.zoom()` owns the wheel/drag
 *     gesture handling on the `<svg>` — but it reports the resulting transform
 *     into React state, which is what actually renders the `transform` attribute
 *     of the pan/zoom group.
 *
 * The canvas fills whatever height its container gives it, so the dialog can hand
 * it nearly the whole screen.
 */

import { useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import { css, keyframes } from '@emotion/react';
import {
  linkVertical,
  select,
  zoom,
  zoomIdentity,
  type D3ZoomEvent,
  type ZoomTransform,
} from 'd3';
import type { JobStatus, NewscastStage } from '@audio-underview/newscast-core';

import { formatBytes, formatElapsed } from './formatting.ts';
import { jobSourceModeFor, skippedStageMetric, type JobSourceMode } from './job-source-mode.ts';
import { STAGE_LABELS, stageStateFor } from './stage-metadata.ts';

/**
 * How a single node renders. `skipped` covers work the run legitimately never
 * did (a pasted newscast's crawl, a sting that failed harmlessly); `error` is the
 * stage recorded in `details.failure` on a failed newscast.
 */
export type PipelineNodeState = 'done' | 'active' | 'pending' | 'skipped' | 'error';

interface PipelineNode {
  id: string;
  label: string;
  /** One short metric line under the label; omitted when the run has no figure yet. */
  metric?: string;
  state: PipelineNodeState;
  /** Stage depth, top→bottom: 0 = fetch list … 6 = finalize. Drives the Y axis. */
  depth: number;
  /** Lane index on the X axis; fractional for the spine centered across lanes. */
  lane: number;
}

interface PipelineEdge {
  from: string;
  to: string;
}

/* Geometry. Seven stacked stage depths make Y the long axis — the one the
   viewport pans along when a small screen cannot show it all — while the lane
   axis stays cheap, so a two- or three-part run (plus the sting) still fits
   across a phone's width at the initial fit instead of being zoomed away. */
const NODE_WIDTH = 136;
const NODE_HEIGHT = 62;
/** Vertical gap between consecutive stage depths — the flow axis. */
const DEPTH_GAP = 36;
/** Horizontal gap between parallel lanes — the fan-out axis. */
const LANE_GAP = 14;

/** Stage depth of the transition-sting node — it branches around script/tts. */
const SIGNAL_DEPTH = 4;
/** Stage depth of the terminal node that every lane merges back into. */
const FINALIZE_DEPTH = 6;

function nodeLeft(lane: number): number {
  return lane * (NODE_WIDTH + LANE_GAP);
}

function nodeTop(depth: number): number {
  return depth * (NODE_HEIGHT + DEPTH_GAP);
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Node state for a real pipeline stage. A stage the newscast's source mode says
 * was never run is `skipped` before anything else is considered; otherwise the
 * CURRENT stage lights up every node at its depth (per-part granularity does not
 * exist in `details`), and the failed stage of an errored newscast wins over the
 * rest.
 */
function stageNodeState(
  stage: NewscastStage,
  status: JobStatus,
  failedStage: NewscastStage | undefined,
  mode: JobSourceMode,
): PipelineNodeState {
  if (skippedStageMetric(stage, mode) !== undefined) {
    return 'skipped';
  }
  if (failedStage === stage) {
    return 'error';
  }
  const state = stageStateFor(stage, status.stage, status.status === 'done');
  if (state === 'complete') {
    return 'done';
  }
  if (state === 'active') {
    // A failed newscast has no stage in flight, so nothing should pulse as active.
    return status.status === 'error' ? 'pending' : 'active';
  }
  return 'pending';
}

interface PipelineGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Canvas width in px. Only the lane axis varies, and only it drives the fit. */
  width: number;
}

function buildPipelineGraph(status: JobStatus): PipelineGraph {
  const details = status.details;
  const result = status.result;
  const isDone = status.status === 'done';
  // `details.failure` may be stale on a newscast that later succeeded, so it is
  // only consulted while the newscast is actually in the error state.
  const failedStage =
    status.status === 'error' ? (details?.failure?.stage ?? status.stage) : undefined;

  const sourceMode = jobSourceModeFor(status);
  // A verbatim newscast runs no organize stage, so its lanes would otherwise stay
  // collapsed to one until the parts land. The worker splits the pasted script
  // at creation and records the count, which makes it the ONLY newscast whose
  // real fan-out is knowable from the first read — hence first in the chain. It
  // is absent on newscasts created before it shipped, which then fall through.
  const declaredVerbatimPartCount = sourceMode.isVerbatim
    ? details?.customArticle?.partCount
    : undefined;
  // Before organize lands the part count is unknown — a single lane is drawn
  // rather than guessing a fan-out that may never happen.
  const partCount = Math.max(
    1,
    declaredVerbatimPartCount ??
      details?.organize?.partCount ??
      result?.parts?.length ??
      details?.partsSummary?.length ??
      1,
  );
  const isMultiLane = partCount > 1;
  const hasSignal =
    details?.signal !== undefined || result?.signalAudioKey !== undefined;

  // The un-parallelized stages sit on a spine centered over the part lanes, so
  // the fan-out and fan-in read as symmetric.
  const spineLane = (partCount - 1) / 2;
  const nodes: PipelineNode[] = [];
  const edges: PipelineEdge[] = [];

  const crawlList = details?.crawlList;
  nodes.push({
    id: 'crawl-list',
    label: STAGE_LABELS['crawl-list'],
    metric:
      skippedStageMetric('crawl-list', sourceMode) ??
      (crawlList !== undefined
        ? `${pluralize(crawlList.count, 'article')} · ${formatBytes(crawlList.bytes)}`
        : undefined),
    state: stageNodeState('crawl-list', status, failedStage, sourceMode),
    depth: 0,
    lane: spineLane,
  });

  const crawlArticles = details?.crawlArticles;
  nodes.push({
    id: 'crawl-articles',
    label: STAGE_LABELS['crawl-articles'],
    metric:
      skippedStageMetric('crawl-articles', sourceMode) ??
      (crawlArticles !== undefined
        ? `${pluralize(crawlArticles.articles.length, 'article')} · ${formatBytes(crawlArticles.totalBytes)}`
        : undefined),
    state: stageNodeState('crawl-articles', status, failedStage, sourceMode),
    depth: 1,
    lane: spineLane,
  });

  const organize = details?.organize;
  nodes.push({
    id: 'organize',
    label: STAGE_LABELS.organize,
    metric:
      skippedStageMetric('organize', sourceMode) ??
      (organize !== undefined
        ? `${pluralize(organize.unitCount, 'unit')} · ${pluralize(organize.partCount, 'part')}`
        : undefined),
    state: stageNodeState('organize', status, failedStage, sourceMode),
    depth: 2,
    lane: spineLane,
  });

  edges.push({ from: 'crawl-list', to: 'crawl-articles' });
  edges.push({ from: 'crawl-articles', to: 'organize' });

  const scriptState = stageNodeState('script', status, failedStage, sourceMode);
  const ttsState = stageNodeState('tts', status, failedStage, sourceMode);
  const mergeState = stageNodeState('merge', status, failedStage, sourceMode);
  // A verbatim newscast writes no script at all, so the lane's turn counts give
  // way to the one fact that matters: this stage was skipped.
  const skippedScriptMetric = skippedStageMetric('script', sourceMode);

  for (let laneIndex = 0; laneIndex < partCount; laneIndex += 1) {
    const partNumber = laneIndex + 1;
    const suffix = isMultiLane ? ` Part ${partNumber}` : '';
    const summary = details?.partsSummary?.[laneIndex];
    const part = result?.parts?.[laneIndex];

    // Actual turns once the part exists; the planned target (marked `~`) while
    // the script for that part is still being written.
    const turns =
      summary?.turns ??
      part?.script.length ??
      (partCount === 1 ? details?.script?.turns : undefined);
    const targetTurns = organize?.turnTargets[laneIndex];
    const scriptMetric =
      skippedScriptMetric ??
      (turns !== undefined
        ? pluralize(turns, 'turn')
        : targetTurns !== undefined
          ? `~${pluralize(targetTurns, 'turn')}`
          : undefined);

    const audioDurationMilliseconds = summary?.audioDurationMs ?? part?.durationMs;
    const ttsMetric = isMultiLane
      ? audioDurationMilliseconds !== undefined
        ? formatElapsed(audioDurationMilliseconds)
        : undefined
      : details?.tts !== undefined
        ? `${pluralize(details.tts.chunks, 'chunk')} · ${formatElapsed(details.tts.audioDurationMs)}`
        : undefined;

    // `details.merge.mp3Bytes` is summed across parts — there is no per-part byte
    // accounting — so a fan-out run shows the total once, on the first lane only.
    const mergeMetric =
      details?.merge === undefined
        ? undefined
        : isMultiLane
          ? laneIndex === 0
            ? `${formatBytes(details.merge.mp3Bytes)} total`
            : undefined
          : formatBytes(details.merge.mp3Bytes);

    const scriptID = `script-${partNumber}`;
    const ttsID = `tts-${partNumber}`;
    const mergeID = `merge-${partNumber}`;

    nodes.push({
      id: scriptID,
      label: `${STAGE_LABELS.script}${suffix}`,
      metric: scriptMetric,
      state: scriptState,
      depth: 3,
      lane: laneIndex,
    });
    nodes.push({
      id: ttsID,
      label: `${STAGE_LABELS.tts}${suffix}`,
      metric: ttsMetric,
      state: ttsState,
      depth: 4,
      lane: laneIndex,
    });
    nodes.push({
      id: mergeID,
      label: `${STAGE_LABELS.merge}${suffix}`,
      metric: mergeMetric,
      state: mergeState,
      depth: 5,
      lane: laneIndex,
    });

    edges.push({ from: 'organize', to: scriptID });
    edges.push({ from: scriptID, to: ttsID });
    edges.push({ from: ttsID, to: mergeID });
    edges.push({ from: mergeID, to: 'finalize' });
  }

  if (hasSignal) {
    const signal = details?.signal;
    const generated = result?.signalAudioKey !== undefined || signal?.generated === true;
    nodes.push({
      id: 'signal',
      label: 'Signal sting',
      metric: generated
        ? signal?.bytes !== undefined
          ? formatBytes(signal.bytes)
          : undefined
        : 'not generated',
      // Generation failure is swallowed by the pipeline (parts just play
      // back-to-back), so a failed sting is `skipped`, never an error.
      state: generated ? 'done' : 'skipped',
      depth: SIGNAL_DEPTH,
      // Parked in the lane just past the last part, so the sting never sits on
      // top of a part chain.
      lane: partCount,
    });
    edges.push({ from: 'organize', to: 'signal' });
    edges.push({ from: 'signal', to: 'finalize' });
  }

  nodes.push({
    id: 'finalize',
    label: 'Finalize',
    metric: isDone ? pluralize(partCount, 'part') : undefined,
    state: stageNodeState('done', status, failedStage, sourceMode),
    depth: FINALIZE_DEPTH,
    lane: spineLane,
  });

  const laneCount = hasSignal ? partCount + 1 : partCount;
  return {
    nodes,
    edges,
    width: laneCount * NODE_WIDTH + (laneCount - 1) * LANE_GAP,
  };
}

/* Text layout inside a node. Sizes are in px rather than rem because the
   overflow estimate below has to reason in the same units the SVG lays out in. */
const NODE_TEXT_PADDING = 10;
const LABEL_FONT_SIZE = 12;
const METRIC_FONT_SIZE = 10;
/** Baselines that optically center one or two lines inside a 62px node box. */
const LABEL_BASELINE_WITH_METRIC = 27;
const LABEL_BASELINE_ALONE = 35;
const METRIC_LINE_HEIGHT = 15;
const TEXT_MAX_WIDTH = NODE_WIDTH - NODE_TEXT_PADDING * 2;

/* Average advance widths as a fraction of the font size. Only two scripts ever
   appear in these labels, and Hangul is full-width where Latin is roughly half. */
const NARROW_CHARACTER_RATIO = 0.58;
const WIDE_CHARACTER_RATIO = 1;
const FIRST_WIDE_CODE_POINT = 0x1100;

/**
 * Estimated rendered width of one text line. SVG has no `text-overflow`, and
 * measuring with `getComputedTextLength` would force a synchronous reflow for
 * every node on every read — an estimate is enough to decide whether a label is
 * in trouble.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    width +=
      fontSize *
      (codePoint >= FIRST_WIDE_CODE_POINT ? WIDE_CHARACTER_RATIO : NARROW_CHARACTER_RATIO);
  }
  return width;
}

/**
 * `textLength` for a line, but only when it genuinely overflows its rect —
 * SVG stretches text to `textLength`, so applying it unconditionally would blow
 * short labels apart. Condensing beats ellipsizing here because the token that
 * would be cut is the trailing part number ("Synthesize speech Part 3"), which is
 * the only thing distinguishing one lane's nodes from another's.
 */
function condensedLength(text: string, fontSize: number): number | undefined {
  return estimateTextWidth(text, fontSize) > TEXT_MAX_WIDTH ? TEXT_MAX_WIDTH : undefined;
}

/* Pan/zoom. The extent keeps the graph legible at both ends: below 0.5 the
   metric line is unreadable, above 2.5 a single node fills the dialog. */
const MINIMUM_SCALE = 0.5;
const MAXIMUM_SCALE = 2.5;
/** Breathing room around the graph so a fitted view never touches the border. */
const CANVAS_PADDING = 16;
/** Floor for containers that impose no height of their own (nothing to fill). */
const MINIMUM_VIEWPORT_HEIGHT = 220;

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
`;

/** Column of viewport + legend that claims whatever height the caller offers. */
const GraphLayout = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`;

/**
 * The window onto the graph. It clips instead of scrolling because d3.zoom owns
 * both axes, and it grows to fill the container rather than clamping to a fixed
 * band: the vertical flow is seven stages tall, so every pixel the dialog can
 * spare shows another stage without a pan.
 */
const Viewport = styled.div`
  position: relative;
  flex: 1;
  min-height: ${MINIMUM_VIEWPORT_HEIGHT}px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--bg-deep);
  overflow: hidden;
`;

const GraphSvg = styled.svg`
  display: block;
  /* <svg> is a REPLACED element: unlike a div, inset: 0 alone does not
     stretch it — auto width/height resolve to the intrinsic 300x150 SVG
     default. The explicit 100% sizes (against the positioned Viewport box)
     are what actually make it fill; absolute positioning keeps the fill
     independent of how flex would size an in-flow child. */
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* d3.zoom consumes wheel and drag itself, so the browser must not also pan. */
  touch-action: none;
  cursor: grab;

  &:active {
    cursor: grabbing;
  }
`;

function nodeBorderColor(state: PipelineNodeState): string {
  if (state === 'done') {
    return 'rgba(34, 197, 94, 0.45)';
  }
  if (state === 'active') {
    return 'var(--accent-primary)';
  }
  if (state === 'error') {
    return 'rgba(239, 68, 68, 0.5)';
  }
  return 'var(--border-subtle)';
}

function nodeFillColor(state: PipelineNodeState): string {
  if (state === 'active') {
    return 'var(--accent-muted)';
  }
  if (state === 'error') {
    return 'rgba(239, 68, 68, 0.1)';
  }
  return 'var(--bg-surface)';
}

/** Dashes read as "no work happened here" for both pending and skipped nodes. */
function strokeDashes(state: PipelineNodeState): string {
  return state === 'pending' || state === 'skipped' ? '4 4' : 'none';
}

const NodeGroup = styled.g<{ state: PipelineNodeState }>`
  opacity: ${(props) => (props.state === 'skipped' ? 0.65 : 1)};
  ${(props) =>
    props.state === 'active'
      ? // Wrapped in `css` because a bare keyframes interpolation into a plain
        // template string is not serialized by Emotion (it warns and drops it).
        css`
          animation: ${pulse} 1.6s ease-in-out infinite;
        `
      : ''}
`;

const NodeRect = styled.rect<{ state: PipelineNodeState }>`
  fill: ${(props) => nodeFillColor(props.state)};
  stroke: ${(props) => nodeBorderColor(props.state)};
  stroke-width: 1;
  stroke-dasharray: ${(props) => strokeDashes(props.state)};
`;

const NodeLabel = styled.text<{ state: PipelineNodeState }>`
  font-size: ${LABEL_FONT_SIZE}px;
  font-weight: ${(props) => (props.state === 'active' ? 700 : 600)};
  fill: ${(props) =>
    props.state === 'error'
      ? 'var(--color-error)'
      : props.state === 'pending' || props.state === 'skipped'
        ? 'var(--text-muted)'
        : 'var(--text-primary)'};
`;

const NodeMetric = styled.tspan`
  font-family: var(--font-mono);
  font-size: ${METRIC_FONT_SIZE}px;
  font-weight: 400;
  fill: var(--text-secondary);
`;

const Legend = styled.div`
  display: flex;
  /* Never give up rows to the viewport — the key has to stay readable. */
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: 0.375rem 0.875rem;
  margin-top: 0.625rem;
  font-size: 0.6875rem;
  color: var(--text-muted);
`;

const LegendItem = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.3125rem;
`;

const LegendDot = styled.span<{ state: PipelineNodeState }>`
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  border: 1px solid ${(props) => nodeBorderColor(props.state)};
  background: ${(props) =>
    props.state === 'done'
      ? 'var(--color-success)'
      : props.state === 'active'
        ? 'var(--accent-primary)'
        : props.state === 'error'
          ? 'var(--color-error)'
          : 'transparent'};
`;

const LEGEND_ITEMS: Array<{ state: PipelineNodeState; label: string }> = [
  { state: 'done', label: 'Done' },
  { state: 'active', label: 'Running' },
  { state: 'pending', label: 'Pending' },
  { state: 'skipped', label: 'Skipped' },
  { state: 'error', label: 'Failed' },
];

/** Edge stroke follows the node it feeds, so a lane reads as one colored chain. */
function edgeStroke(state: PipelineNodeState): string {
  if (state === 'done') {
    return 'rgba(34, 197, 94, 0.4)';
  }
  if (state === 'active') {
    return 'var(--accent-primary)';
  }
  if (state === 'error') {
    return 'rgba(239, 68, 68, 0.45)';
  }
  return 'rgba(255, 255, 255, 0.12)';
}

const EdgePath = styled.path<{ state: PipelineNodeState }>`
  fill: none;
  stroke: ${(props) => edgeStroke(props.state)};
  stroke-width: ${(props) => (props.state === 'active' ? 2 : 1.5)};
  stroke-dasharray: ${(props) => strokeDashes(props.state)};
`;

/** Endpoints of one edge in canvas coordinates: bottom of A → top of B. */
interface EdgeEndpoints {
  source: [number, number];
  target: [number, number];
}

/**
 * The edge curve generator. Stateless and shared, so it is built once at module
 * scope; `linkVertical` emits a vertically-tangent cubic, which is what makes a
 * fan-out leave the spine downward instead of shooting sideways out of a corner.
 */
const edgeCurve = linkVertical<EdgeEndpoints, [number, number]>()
  .source((endpoints) => endpoints.source)
  .target((endpoints) => endpoints.target);

function edgeEndpoints(from: PipelineNode, to: PipelineNode): EdgeEndpoints {
  return {
    source: [nodeLeft(from.lane) + NODE_WIDTH / 2, nodeTop(from.depth) + NODE_HEIGHT],
    target: [nodeLeft(to.lane) + NODE_WIDTH / 2, nodeTop(to.depth)],
  };
}

export interface NewscastPipelineGraphProps {
  status: JobStatus;
}

/**
 * The pipeline graph for one newscast. Every node, edge, and metric comes from
 * `status`, so it re-renders straight off the existing read; the only local
 * state is the pan/zoom transform the user drove.
 */
export function NewscastPipelineGraph({ status }: NewscastPipelineGraphProps) {
  const { nodes, edges, width } = buildPipelineGraph(status);
  const nodesByID = new Map(nodes.map((node) => [node.id, node]));

  const svgRef = useRef<SVGSVGElement | null>(null);
  // The transform lives in React state rather than being written onto the group
  // by d3: React must stay the single writer of everything it rendered, and a
  // handful of setState calls per gesture is nothing for a graph this size.
  const [viewTransform, setViewTransform] = useState<ZoomTransform>(zoomIdentity);

  const contentWidth = width + CANVAS_PADDING * 2;

  useEffect(() => {
    const svgElement = svgRef.current;
    if (svgElement === null) {
      return;
    }
    const selection = select(svgElement);
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MINIMUM_SCALE, MAXIMUM_SCALE])
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setViewTransform(event.transform);
      });
    selection.call(zoomBehavior);

    // Initial fit is on WIDTH alone: the vertical flow is narrow, so fitting the
    // lanes across the viewport is what makes the whole fan-out visible at once
    // on a phone — while fitting the height would shrink every node to nothing
    // to squeeze seven stages in. Never magnify past 1:1, which would just make
    // a one-lane run look bloated. Layout may not have happened yet (a hidden
    // container measures 0), in which case 1:1 is the honest fallback.
    const measuredWidth = svgElement.getBoundingClientRect().width;
    const viewportWidth = measuredWidth > 0 ? measuredWidth : contentWidth;
    const fitScale = Math.min(1, Math.max(MINIMUM_SCALE, viewportWidth / contentWidth));
    // Top-aligned (y = 0): the run starts at the top, so that is what should be
    // on screen; the user scrolls the pipeline downward as it progresses.
    const fittedTransform = zoomIdentity
      .translate((viewportWidth - contentWidth * fitScale) / 2, 0)
      .scale(fitScale);
    // Through `zoomBehavior.transform` so d3's own stored transform matches what
    // React renders; a later gesture then continues from the fitted view.
    selection.call(zoomBehavior.transform, fittedTransform);

    return () => {
      // Detach every listener d3.zoom installed (wheel, pointer, dblclick…).
      selection.on('.zoom', null);
    };
    // Re-fits only when the graph's own width changes — e.g. organize landing
    // and fanning one lane into three — so an ordinary read never yanks the
    // user's pan back to the start. The height is the same seven depths for
    // every run, so it can never trigger a re-fit.
  }, [contentWidth]);

  return (
    <GraphLayout>
      <Viewport>
        <GraphSvg
          ref={svgRef}
          role="group"
          aria-label="Pipeline graph"
          data-testid="pipeline-graph-canvas"
        >
          <g
            data-testid="pipeline-graph-viewport"
            transform={viewTransform.toString()}
          >
            <g transform={`translate(${CANVAS_PADDING},${CANVAS_PADDING})`}>
              <g aria-hidden={true}>
                {edges.map((edge) => {
                  const from = nodesByID.get(edge.from);
                  const to = nodesByID.get(edge.to);
                  if (from === undefined || to === undefined) {
                    return null;
                  }
                  return (
                    <EdgePath
                      key={`${edge.from}->${edge.to}`}
                      state={to.state}
                      d={edgeCurve(edgeEndpoints(from, to)) ?? undefined}
                      data-edge={`${edge.from}->${edge.to}`}
                    />
                  );
                })}
              </g>
              {nodes.map((node) => {
                const labelLength = condensedLength(node.label, LABEL_FONT_SIZE);
                const metricLength =
                  node.metric === undefined
                    ? undefined
                    : condensedLength(node.metric, METRIC_FONT_SIZE);
                return (
                  <NodeGroup
                    key={node.id}
                    state={node.state}
                    transform={`translate(${nodeLeft(node.lane)},${nodeTop(node.depth)})`}
                    data-node-id={node.id}
                    data-node-state={node.state}
                  >
                    <NodeRect
                      state={node.state}
                      width={NODE_WIDTH}
                      height={NODE_HEIGHT}
                      rx={10}
                    />
                    <NodeLabel
                      state={node.state}
                      x={NODE_TEXT_PADDING}
                      y={
                        node.metric === undefined
                          ? LABEL_BASELINE_ALONE
                          : LABEL_BASELINE_WITH_METRIC
                      }
                    >
                      <tspan
                        x={NODE_TEXT_PADDING}
                        textLength={labelLength}
                        lengthAdjust={
                          labelLength === undefined ? undefined : 'spacingAndGlyphs'
                        }
                      >
                        {node.label}
                      </tspan>
                      {node.metric !== undefined && (
                        <NodeMetric
                          x={NODE_TEXT_PADDING}
                          dy={METRIC_LINE_HEIGHT}
                          textLength={metricLength}
                          lengthAdjust={
                            metricLength === undefined ? undefined : 'spacingAndGlyphs'
                          }
                        >
                          {node.metric}
                        </NodeMetric>
                      )}
                    </NodeLabel>
                  </NodeGroup>
                );
              })}
            </g>
          </g>
        </GraphSvg>
      </Viewport>
      <Legend>
        {LEGEND_ITEMS.map((item) => (
          <LegendItem key={item.state}>
            <LegendDot state={item.state} aria-hidden={true} />
            {item.label}
          </LegendItem>
        ))}
      </Legend>
    </GraphLayout>
  );
}
