/**
 * Source articles of a finished newscast, each linking to the original page and,
 * when the article came from GeekNews, its discussion. The URLs come from crawled
 * pages, so only http and https URLs become links.
 */

import styled from '@emotion/styled';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare,
  faComments,
  faPenToSquare,
} from '@fortawesome/free-solid-svg-icons';
import type { Article } from '@audio-underview/newscast-core';
import { isHTTPURL } from './http-url.ts';

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
`;

const Card = styled.li`
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem 1rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
`;

const TitleLink = styled.a`
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
`;

const DiscussionLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: var(--text-secondary);
  align-self: flex-start;
`;

/** Plain (non-link) title for a pasted article, which has no source URL, or one whose URL is not http(s). */
const TitleText = styled.span`
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
`;

/** Pill marking a source that came from pasted text rather than a page. */
const CustomBadge = styled.span`
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--accent-muted);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 0.125rem 0.5rem;
`;

export interface NewscastSourcesProps {
  sources: Article[];
}

export function NewscastSources({ sources }: NewscastSourcesProps) {
  return (
    <List>
      {sources.map((article, index) => {
        // A pasted article carries no source URLs — render its title as plain
        // text with a "Direct input" badge instead of the two dead links.
        const isCustom =
          article.originalUrl.length === 0 && article.discussionUrl.length === 0;
        return (
          <Card key={index}>
            {isCustom ? (
              <>
                <TitleText>{article.title}</TitleText>
                <CustomBadge>
                  <FontAwesomeIcon icon={faPenToSquare} aria-hidden={true} />
                  Direct input
                </CustomBadge>
              </>
            ) : (
              <>
                {isHTTPURL(article.originalUrl) ? (
                  <TitleLink href={article.originalUrl} target="_blank" rel="noreferrer">
                    {article.title}
                    <FontAwesomeIcon icon={faArrowUpRightFromSquare} aria-hidden={true} />
                  </TitleLink>
                ) : (
                  <TitleText>{article.title}</TitleText>
                )}
                {/* An article read from a URL has no GeekNews discussion. */}
                {isHTTPURL(article.discussionUrl) && (
                  <DiscussionLink href={article.discussionUrl} target="_blank" rel="noreferrer">
                    <FontAwesomeIcon icon={faComments} aria-hidden={true} />
                    GeekNews discussion
                  </DiscussionLink>
                )}
              </>
            )}
          </Card>
        );
      })}
    </List>
  );
}
