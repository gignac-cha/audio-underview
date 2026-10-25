/**
 * The GeekNews pick of a waiting form: the choices of its first field (crawled article titles,
 * with the original URL under each), of which the user picks between the field's minItems and
 * maxItems. Everything here came from crawled pages, so it is rendered as text only — no link, no
 * markup.
 */

import { useState } from 'react';
import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { MAX_PARALLEL_NEWSCASTS } from '@audio-underview/newscast-core';
import type { StageRunForm } from '../../schemas/newscast-schedulers.ts';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
`;

const Count = styled.span`
  flex: 1;
  font-size: 0.75rem;
  color: var(--text-secondary);
`;

const Deadline = styled.span`
  font-size: 0.71875rem;
  font-family: var(--font-mono);
  color: var(--text-muted);
`;

const ChoiceScroller = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  max-height: 17rem;
  overflow-y: auto;
`;

const ChoiceRow = styled.li<{ checked: boolean }>`
  list-style: none;
  border-radius: 8px;
  background: ${(props) => (props.checked ? 'var(--accent-muted)' : 'transparent')};
  transition: var(--transition-fast);

  &:hover {
    background: var(--accent-muted);
  }
`;

const ChoiceLabel = styled.label`
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.5rem 0.625rem;
  cursor: pointer;
`;

const Checkbox = styled.input`
  margin-top: 0.2rem;
  accent-color: var(--accent-primary);
  cursor: pointer;
`;

const ChoiceBody = styled.span`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
`;

const ChoiceTitle = styled.span`
  font-size: 0.8125rem;
  line-height: 1.5;
`;

const ChoiceDescription = styled.span`
  font-size: 0.6875rem;
  color: var(--text-muted);
  overflow-wrap: anywhere;
`;

const Actions = styled.div`
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
`;

const AnswerButton = styled.button`
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 700;
  padding: 0.7rem 1rem;
  border-radius: 10px;
  color: var(--text-primary);
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

const CancelButton = styled.button`
  padding: 0.7rem 1rem;
  border-radius: 10px;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: var(--transition-fast);

  &:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-focus);
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;

function formatDeadline(expiresAt: string): string | undefined {
  const milliseconds = Date.parse(expiresAt);
  if (Number.isNaN(milliseconds)) {
    return undefined;
  }
  return new Date(milliseconds).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

interface ArticleChoicePickerProps {
  form: StageRunForm;
  /** True while the answer or the cancel is on its way */
  isBusy: boolean;
  onAnswer: (indices: number[]) => void;
  onCancel: () => void;
}

export function ArticleChoicePicker({ form, isBusy, onAnswer, onCancel }: ArticleChoicePickerProps) {
  const field = form.fields[0];
  const choices = field?.choices ?? [];
  const maximumCount = Math.min(field?.maxItems ?? MAX_PARALLEL_NEWSCASTS, MAX_PARALLEL_NEWSCASTS);
  const minimumCount = Math.max(field?.minItems ?? 1, 1);
  // Nothing is picked up front: every newscast is an explicit choice
  const [selected, setSelected] = useState<number[]>([]);
  const atMaximum = selected.length >= maximumCount;
  const deadline = formatDeadline(form.expires_at);

  const toggle = (index: number) => {
    setSelected((previous) => {
      if (previous.includes(index)) {
        return previous.filter((selectedIndex) => selectedIndex !== index);
      }
      if (previous.length >= maximumCount) {
        return previous;
      }
      return [...previous, index];
    });
  };

  const handleAnswer = () => {
    // In the order of the list, which is the order the newscasts are made in
    onAnswer([...selected].sort((left, right) => left - right));
  };

  return (
    <Container role="group" aria-label="GeekNews articles">
      <Toolbar>
        <Count>
          {selected.length} of {choices.length} selected · max {maximumCount}
        </Count>
        {deadline !== undefined && <Deadline>Pick by {deadline}</Deadline>}
      </Toolbar>
      <ChoiceScroller>
        {choices.map((choice, index) => {
          const checked = selected.includes(index);
          return (
            <ChoiceRow key={index} checked={checked}>
              <ChoiceLabel>
                <Checkbox
                  type="checkbox"
                  checked={checked}
                  disabled={isBusy || (!checked && atMaximum)}
                  onChange={() => toggle(index)}
                />
                <ChoiceBody>
                  <ChoiceTitle>{choice.label}</ChoiceTitle>
                  {choice.description !== undefined && choice.description.length > 0 && (
                    <ChoiceDescription>{choice.description}</ChoiceDescription>
                  )}
                </ChoiceBody>
              </ChoiceLabel>
            </ChoiceRow>
          );
        })}
      </ChoiceScroller>
      <Actions>
        <AnswerButton type="button" onClick={handleAnswer} disabled={isBusy || selected.length < minimumCount}>
          <FontAwesomeIcon icon={faWandMagicSparkles} aria-hidden={true} />
          {`Make ${selected.length} newscast${selected.length === 1 ? '' : 's'}`}
        </AnswerButton>
        <CancelButton type="button" onClick={onCancel} disabled={isBusy}>
          Cancel
        </CancelButton>
      </Actions>
    </Container>
  );
}
