import { useState } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router';
import { useToast } from '../../hooks/use-toast.ts';
import { useCreateCrawler } from '../../hooks/use-crawler-manager.ts';

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
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90vw;
  max-width: 480px;
  box-shadow: var(--shadow-md);
`;

const Title = styled(Dialog.Title)`
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 1rem 0;
`;

const Description = styled(Dialog.Description)`
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0 0 1.25rem 0;
  line-height: 1.5;
`;

const FieldGroup = styled.div`
  margin-bottom: 1rem;
`;

const FieldLabel = styled.label`
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.375rem;
`;

const TextInput = styled.input`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const RegexInput = styled.input`
  width: 100%;
  padding: 0.625rem 0.875rem;
  background: var(--bg-deep);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-family: var(--font-mono);
  outline: none;
  transition: var(--transition-fast);

  &::placeholder {
    color: var(--text-muted);
  }

  &:focus {
    border-color: var(--border-focus);
  }
`;

const MatchPreview = styled('div', {
  shouldForwardProp: (prop) => prop !== 'isMatch',
})<{ isMatch: boolean }>`
  margin-top: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-deep);
  border-radius: 6px;
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: ${({ isMatch }) => (isMatch ? 'var(--color-success)' : 'var(--color-error)')};
`;

const ButtonRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 1.5rem;
`;

const CancelButton = styled.button`
  padding: 0.5rem 1rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover {
    color: var(--text-primary);
    background: var(--bg-deep);
  }
`;

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Spinner = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: ${spin} 0.6s linear infinite;
`;

const SubmitButton = styled('button', {
  shouldForwardProp: (prop) => prop !== 'isSubmitting',
})<{ isSubmitting?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--accent-primary);
  cursor: ${({ isSubmitting }) => (isSubmitting ? 'not-allowed' : 'pointer')};
  opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 1)};
  transition: var(--transition-fast);

  &:hover {
    opacity: ${({ isSubmitting }) => (isSubmitting ? 0.7 : 0.9)};
  }
`;

interface CrawlerSubmissionDialogProperties {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  url: string;
  code: string;
}

export function CrawlerSubmissionDialog({
  open,
  onOpenChange,
  url,
  code,
}: CrawlerSubmissionDialogProperties) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { createCrawler, status } = useCreateCrawler();
  const [name, setName] = useState('');
  const [urlPattern, setURLPattern] = useState('');

  const isSubmitting = status === 'pending';

  const testMatch = (() => {
    if (!urlPattern || !url) return null;
    try {
      const regex = new RegExp(urlPattern);
      return regex.test(url);
    } catch {
      return false;
    }
  })();

  const handleSubmit = async () => {
    if (!name.trim()) {
      showToast('Validation Error', 'Please enter a crawler name.', 'error');
      return;
    }
    if (!urlPattern.trim()) {
      showToast('Validation Error', 'Please enter a URL pattern.', 'error');
      return;
    }

    try {
      await createCrawler({
        name: name.trim(),
        url_pattern: urlPattern.trim(),
        code,
      });
      showToast('Success', 'Crawler saved successfully.', 'success');
      onOpenChange(false);
      navigate('/crawlers');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save crawler';
      showToast('Error', message, 'error');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Overlay />
        <Content>
          <Title>Submit Crawler</Title>
          <Description>
            Give your crawler a name and define a URL pattern to match pages it should process.
          </Description>

          <FieldGroup>
            <FieldLabel>Name</FieldLabel>
            <TextInput
              placeholder="My Crawler"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isSubmitting}
            />
          </FieldGroup>

          <FieldGroup>
            <FieldLabel>URL Pattern (Regex)</FieldLabel>
            <RegexInput
              placeholder="^https://example\\.com/posts/.*$"
              value={urlPattern}
              onChange={(event) => setURLPattern(event.target.value)}
              disabled={isSubmitting}
            />
          </FieldGroup>

          {url && urlPattern && testMatch !== null && (
            <MatchPreview isMatch={testMatch}>
              {testMatch ? 'Pattern matches the test URL' : 'Pattern does not match the test URL'}
              <br />
              Test URL: {url}
            </MatchPreview>
          )}

          <ButtonRow>
            <Dialog.Close asChild>
              <CancelButton disabled={isSubmitting}>Cancel</CancelButton>
            </Dialog.Close>
            <SubmitButton
              onClick={handleSubmit}
              disabled={isSubmitting}
              isSubmitting={isSubmitting}
            >
              {isSubmitting && <Spinner />}
              {isSubmitting ? 'Submitting...' : 'Submit'}
            </SubmitButton>
          </ButtonRow>
        </Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
