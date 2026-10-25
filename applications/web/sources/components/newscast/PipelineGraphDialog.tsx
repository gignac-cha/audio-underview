/**
 * Modal wrapper around {@link NewscastPipelineGraph} — the graph is far taller
 * than the detail pane, so it lives in a near-fullscreen dialog instead of
 * squeezing the inspection column.
 *
 * Sizing is deliberate: the vertical flow is seven stages deep, and on a phone
 * an 80vh box minus header and legend left a letterbox showing two of them. The
 * dialog takes essentially the whole viewport and hands every leftover pixel to
 * the graph through one flex column — no inner scroller, because d3.zoom owns
 * panning inside the canvas and a scrollbar fighting it is how the gesture ends
 * up ambiguous.
 *
 * Controlled, and styled after `FullScriptDialog` in ScriptCaptions.tsx so both
 * newscast modals share one look.
 */

import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import type { JobStatus } from '@audio-underview/newscast-core';

import { NewscastPipelineGraph } from './NewscastPipelineGraph.tsx';

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
  width: min(94vw, 720px);
  /* A fixed height (not max-height) is what lets the graph claim the leftover
     space — a max-height box would shrink to the legend and starve the canvas.
     The vh line is the fallback for engines without dvh; dvh is what keeps the
     dialog off the mobile URL bar. The 56rem cap is roughly the height at which
     the whole seven-stage flow is already visible at 1:1, so a tall desktop
     window stops growing an empty box. */
  height: min(88vh, 56rem);
  height: min(88dvh, 56rem);
  box-shadow: var(--shadow-md);
`;

const DialogHeader = styled.div`
  display: flex;
  /* The title row keeps its height; only the graph below it flexes. */
  flex-shrink: 0;
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

/**
 * The graph's slot in the dialog column: everything the header did not take.
 * `min-height: 0` is the part that matters — without it a flex child refuses to
 * shrink below its content and the canvas would push the dialog past its height.
 */
const GraphBody = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`;

export interface PipelineGraphDialogProps {
  status: JobStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PipelineGraphDialog({
  status,
  open,
  onOpenChange,
}: PipelineGraphDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Pipeline graph</DialogTitle>
            <Dialog.Close asChild>
              <CloseButton type="button">
                <FontAwesomeIcon icon={faXmark} aria-hidden={true} />
                Close
              </CloseButton>
            </Dialog.Close>
          </DialogHeader>
          <GraphBody>
            <NewscastPipelineGraph status={status} />
          </GraphBody>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
