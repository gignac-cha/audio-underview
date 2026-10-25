/**
 * Owner-side "Share" dialog — opened from {@link NewscastDetail}'s hero row only
 * while a newscast is `done`. Self-contained: it owns its own data via
 * {@link useNewscastShare}, so the parent only needs to mount it with a newscast
 * ID and an open flag.
 *
 * No link yet: every metadata toggle starts OFF (everything is private by
 * default) and nothing is sent until "Create link". A link already exists: every
 * toggle change PUTs immediately — there is no separate save step once the link
 * is live, so what the owner sees always matches what is public.
 *
 * The `displayName` / `email` toggles are the odd ones out: unlike the other
 * three (booleans the WORKER resolves from the newscast's data), these two carry
 * a client-supplied STRING snapshot. The dialog always previews the CURRENT
 * session value next to the toggle — never a stale stored one — so "published
 * exactly as shown" is literally true even after the owner's profile name
 * changes between visits.
 */

import { useState } from 'react';
import styled from '@emotion/styled';
import * as Dialog from '@radix-ui/react-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCopy, faXmark } from '@fortawesome/free-solid-svg-icons';
import type { OAuthUser } from '@audio-underview/sign-provider';

import { useAuthentication } from '../../hooks/use-authentication.ts';
import { useToast } from '../../hooks/use-toast.ts';
import {
  shareURLForToken,
  useNewscastShare,
  type ShareMetadata,
  type ShareState,
} from '../../hooks/use-newscast-share.ts';
import { DiscardDialog } from '../DiscardDialog.tsx';

/** Local UI state for the four+one toggles — always in sync with the wire shape via {@link togglesFromMetadata} / {@link metadataFromToggles}. */
interface ShareToggles {
  showDisplayName: boolean;
  showEmail: boolean;
  showModel: boolean;
  showSourceLinks: boolean;
  showCreatedAt: boolean;
}

const ALL_TOGGLES_OFF: ShareToggles = {
  showDisplayName: false,
  showEmail: false,
  showModel: false,
  showSourceLinks: false,
  showCreatedAt: false,
};

/** Derives the toggle switches' positions from the server's stored metadata. */
function togglesFromMetadata(metadata: ShareMetadata | undefined): ShareToggles {
  return {
    showDisplayName: metadata?.displayName !== undefined,
    showEmail: metadata?.email !== undefined,
    showModel: metadata?.showModel === true,
    showSourceLinks: metadata?.showSourceLinks === true,
    showCreatedAt: metadata?.showCreatedAt === true,
  };
}

/**
 * Builds the PUT body from the current toggles + the live session user — an
 * OFF toggle omits its key entirely rather than sending an explicit `false`,
 * so the wire payload only ever lists what is actually about to become public.
 */
function metadataFromToggles(toggles: ShareToggles, user: OAuthUser | undefined): ShareMetadata {
  const metadata: ShareMetadata = {};
  if (toggles.showDisplayName && user !== undefined && user.name.length > 0) {
    metadata.displayName = user.name;
  }
  const email = user?.email;
  if (toggles.showEmail && email !== undefined && email !== null && email.length > 0) {
    metadata.email = email;
  }
  if (toggles.showModel) {
    metadata.showModel = true;
  }
  if (toggles.showSourceLinks) {
    metadata.showSourceLinks = true;
  }
  if (toggles.showCreatedAt) {
    metadata.showCreatedAt = true;
  }
  return metadata;
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
  gap: 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.25rem;
  width: 92vw;
  max-width: 30rem;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-md);
`;

const DialogHeader = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
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

const Note = styled.p`
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--text-muted);
`;

const LinkRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const LinkInput = styled.input`
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--text-primary);
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 0.4rem 0.625rem;
`;

const CopyButton = styled.button<{ copied: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
  color: ${(props) => (props.copied ? 'var(--color-success)' : '#ffffff')};
  background: ${(props) => (props.copied ? 'transparent' : 'var(--accent-primary)')};
  border: 1px solid ${(props) => (props.copied ? 'var(--color-success)' : 'transparent')};
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const ToggleList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
`;

const ToggleRow = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
`;

const ToggleLabelColumn = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
`;

const ToggleLabel = styled.span`
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
`;

const TogglePreview = styled.span`
  font-size: 0.71875rem;
  color: var(--text-muted);
  overflow-wrap: anywhere;
`;

const ToggleSwitch = styled('button', {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active: boolean }>`
  flex-shrink: 0;
  position: relative;
  width: 36px;
  height: 20px;
  margin-top: 0.125rem;
  border-radius: 10px;
  border: none;
  padding: 0;
  background: ${(props) => (props.active ? 'var(--accent-primary)' : 'var(--border-subtle)')};
  cursor: pointer;
  transition: background 0.2s;

  &::after {
    content: '';
    position: absolute;
    top: 2px;
    left: ${(props) => (props.active ? '18px' : '2px')};
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #ffffff;
    transition: left 0.2s;
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const ActionRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const PrimaryButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 700;
  color: #ffffff;
  background: var(--accent-primary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const SecondaryButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary);
  background: transparent;
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    border-color: var(--accent-primary);
    background: var(--accent-muted);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
`;

const DangerButton = styled(SecondaryButton)`
  color: var(--color-error);

  &:hover:not(:disabled) {
    border-color: var(--color-error);
    background: rgba(239, 68, 68, 0.08);
  }
`;

const LoadingNote = styled(Note)`
  padding: 0.5rem 0;
`;

const ErrorNote = styled(Note)`
  color: var(--color-error);
`;

/** How long the "Copied" state shows before the button reverts to "Copy". */
const COPY_FEEDBACK_MILLISECONDS = 2000;

export interface NewscastShareDialogProps {
  jobID: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NewscastShareDialog({ jobID, open, onOpenChange }: NewscastShareDialogProps) {
  const { user } = useAuthentication();
  const { showError, showSuccess } = useToast();
  const {
    shareState,
    isLoading,
    error,
    createOrUpdateShare,
    reissueShare,
    revokeShare,
    isSaving,
    isRevoking,
  } = useNewscastShare(open ? jobID : undefined);

  const [toggles, setToggles] = useState<ShareToggles>(ALL_TOGGLES_OFF);
  // `copied` needs no reset-on-open effect: NewscastDetail mounts this dialog
  // lazily (only while it is open), so a fresh `useState(false)` on every open
  // already starts clean — there is no persistent instance to leak into.
  const [copied, setCopied] = useState(false);
  const [isReissueConfirmOpen, setIsReissueConfirmOpen] = useState(false);

  // Keep the local toggle switches in lockstep with server truth: the initial
  // GET, and every PUT/DELETE's own known-correct cache write (a mutation's
  // cached metadata is always exactly what this block would already compute
  // from `toggles`, so re-deriving here is a no-op on the mutation path and the
  // only path that matters on first load).
  //
  // Adjusting state during render (React's documented alternative to an Effect
  // for "sync local state to an external value") rather than `useEffect`, so
  // the sync lands in the SAME commit as the data arriving — no extra frame
  // where the switches still show stale positions.
  const [syncedShareState, setSyncedShareState] = useState<ShareState | undefined>(undefined);
  if (shareState !== syncedShareState) {
    setSyncedShareState(shareState);
    if (shareState !== undefined) {
      setToggles(togglesFromMetadata(shareState.shared ? shareState.metadata : undefined));
    }
  }

  // Narrowed once here (rather than re-checking `shareState.shared === true`
  // at every use below) so TypeScript's control-flow analysis actually tracks
  // `.token` / `.metadata` as present everywhere this is defined.
  const linkedShareState = shareState?.shared === true ? shareState : undefined;
  const isLinked = linkedShareState !== undefined;
  const shareURL =
    linkedShareState !== undefined ? shareURLForToken(linkedShareState.token) : undefined;

  const handleMutationError = (action: string) => (mutationError: unknown) => {
    showError(action, mutationError instanceof Error ? mutationError.message : String(mutationError));
  };

  const handleToggle = (key: keyof ShareToggles) => {
    const previous = toggles;
    const next = { ...toggles, [key]: !toggles[key] };
    setToggles(next);
    // Before a link exists this is pure local draft state — "Create link" is
    // what actually sends it. Once linked, every change applies immediately.
    if (isLinked) {
      createOrUpdateShare(metadataFromToggles(next, user)).catch((mutationError: unknown) => {
        setToggles(previous);
        handleMutationError('Could not save the share settings')(mutationError);
      });
    }
  };

  const handleCreateLink = () => {
    createOrUpdateShare(metadataFromToggles(toggles, user)).catch(
      handleMutationError('Could not create the share link'),
    );
  };

  const handleRevoke = () => {
    revokeShare().catch(handleMutationError('Could not revoke the share link'));
  };

  const handleConfirmReissue = () => {
    setIsReissueConfirmOpen(false);
    reissueShare(metadataFromToggles(toggles, user))
      .then(() => showSuccess('Issued a new link', 'The old link no longer opens.'))
      .catch(handleMutationError('Could not issue a new link'));
  };

  const handleCopy = () => {
    if (shareURL === undefined) {
      return;
    }
    navigator.clipboard
      .writeText(shareURL)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPY_FEEDBACK_MILLISECONDS);
      })
      .catch(() => {
        showError('Could not copy', 'Check that the browser may use the clipboard.');
      });
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Overlay />
          <Content aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Share</DialogTitle>
              <Dialog.Close asChild>
                <CloseButton type="button">
                  <FontAwesomeIcon icon={faXmark} aria-hidden={true} />
                  Close
                </CloseButton>
              </Dialog.Close>
            </DialogHeader>

            {isLoading && <LoadingNote>Loading…</LoadingNote>}
            {error !== undefined && <ErrorNote role="alert">{error.message}</ErrorNote>}

            {!isLoading && error === undefined && (
              <>
                {linkedShareState !== undefined && (
                  <>
                    <LinkRow>
                      <LinkInput
                        type="text"
                        readOnly={true}
                        value={shareURL ?? linkedShareState.token}
                        aria-label="Share link"
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <CopyButton
                        type="button"
                        copied={copied}
                        disabled={shareURL === undefined}
                        onClick={handleCopy}
                      >
                        <FontAwesomeIcon icon={copied ? faCheck : faCopy} aria-hidden={true} />
                        {copied ? 'Copied' : 'Copy'}
                      </CopyButton>
                    </LinkRow>
                    {shareURL === undefined && (
                      <Note>
                        VITE_SHARE_VIEWER_URL is not set, so the whole link cannot be built. Only
                        the token is shown.
                      </Note>
                    )}
                  </>
                )}

                <ToggleList>
                  <ToggleRow>
                    <ToggleLabelColumn>
                      <ToggleLabel>Your name</ToggleLabel>
                      <TogglePreview>Preview: {user?.name ?? '—'}</TogglePreview>
                    </ToggleLabelColumn>
                    <ToggleSwitch
                      type="button"
                      role="switch"
                      aria-checked={toggles.showDisplayName}
                      aria-label="Show your name"
                      active={toggles.showDisplayName}
                      disabled={isSaving}
                      onClick={() => handleToggle('showDisplayName')}
                    />
                  </ToggleRow>
                  <ToggleRow>
                    <ToggleLabelColumn>
                      <ToggleLabel>Your email</ToggleLabel>
                      <TogglePreview>Preview: {user?.email ?? '—'}</TogglePreview>
                    </ToggleLabelColumn>
                    <ToggleSwitch
                      type="button"
                      role="switch"
                      aria-checked={toggles.showEmail}
                      aria-label="Show your email"
                      active={toggles.showEmail}
                      disabled={isSaving}
                      onClick={() => handleToggle('showEmail')}
                    />
                  </ToggleRow>
                  <Note>The previewed values are published exactly as shown.</Note>
                  <ToggleRow>
                    <ToggleLabelColumn>
                      <ToggleLabel>Model</ToggleLabel>
                      <TogglePreview>Provider, model and reasoning effort</TogglePreview>
                    </ToggleLabelColumn>
                    <ToggleSwitch
                      type="button"
                      role="switch"
                      aria-checked={toggles.showModel}
                      aria-label="Show the model"
                      active={toggles.showModel}
                      disabled={isSaving}
                      onClick={() => handleToggle('showModel')}
                    />
                  </ToggleRow>
                  <ToggleRow>
                    <ToggleLabelColumn>
                      <ToggleLabel>Source links</ToggleLabel>
                      <TogglePreview>Article titles and links to the originals</TogglePreview>
                    </ToggleLabelColumn>
                    <ToggleSwitch
                      type="button"
                      role="switch"
                      aria-checked={toggles.showSourceLinks}
                      aria-label="Show the source links"
                      active={toggles.showSourceLinks}
                      disabled={isSaving}
                      onClick={() => handleToggle('showSourceLinks')}
                    />
                  </ToggleRow>
                  <ToggleRow>
                    <ToggleLabelColumn>
                      <ToggleLabel>Creation date</ToggleLabel>
                    </ToggleLabelColumn>
                    <ToggleSwitch
                      type="button"
                      role="switch"
                      aria-checked={toggles.showCreatedAt}
                      aria-label="Show the creation date"
                      active={toggles.showCreatedAt}
                      disabled={isSaving}
                      onClick={() => handleToggle('showCreatedAt')}
                    />
                  </ToggleRow>
                </ToggleList>

                {isLinked ? (
                  <ActionRow>
                    <DangerButton type="button" onClick={handleRevoke} disabled={isRevoking}>
                      {isRevoking ? 'Revoking…' : 'Revoke link'}
                    </DangerButton>
                    <SecondaryButton
                      type="button"
                      onClick={() => setIsReissueConfirmOpen(true)}
                      disabled={isSaving || isRevoking}
                    >
                      Issue a new link
                    </SecondaryButton>
                  </ActionRow>
                ) : (
                  <ActionRow>
                    <PrimaryButton type="button" onClick={handleCreateLink} disabled={isSaving}>
                      {isSaving ? 'Creating…' : 'Create link'}
                    </PrimaryButton>
                  </ActionRow>
                )}
              </>
            )}
          </Content>
        </Dialog.Portal>
      </Dialog.Root>

      <DiscardDialog
        open={isReissueConfirmOpen}
        onOpenChange={setIsReissueConfirmOpen}
        onConfirm={handleConfirmReissue}
        title="Issue a new link?"
        description="The current share link stops working at once. Anyone who already has it can no longer open it."
        confirmLabel="Issue"
        keepLabel="Cancel"
      />
    </>
  );
}
