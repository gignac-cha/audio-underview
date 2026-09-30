import type { ReactNode } from 'react';
import styled from '@emotion/styled';
import { keyframes } from '@emotion/react';
import { color, durationValue, fontSize, lineHeight, media, radius, size, space } from '../tokens.ts';
import { VisuallyHidden } from './VisuallyHidden.tsx';

export type SkeletonShape = 'text' | 'block' | 'circle';
export type SkeletonWidth = 'full' | 'long' | 'medium' | 'short';
export type SkeletonTextSize = keyof typeof fontSize;

export interface SkeletonProps {
  /** `text` is one line of text, `block` a rectangle, `circle` a profile image. */
  shape?: SkeletonShape;
  /** Width of a `text` or `block` placeholder: 100%, 75%, 50%, or 30%. */
  width?: SkeletonWidth;
  /** For `text`: the font size of the line it stands in for, so the height matches. */
  textSize?: SkeletonTextSize;
  /** For `block` and `circle`: height (and diameter) as a token value, for example `size.avatarLarge`. */
  height?: string;
}

const WIDTHS: Record<SkeletonWidth, string> = {
  full: '100%',
  long: '75%',
  medium: '50%',
  short: '30%',
};

const shimmer = keyframes`
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0 0;
  }
`;

const Placeholder = styled.span`
  display: block;
  flex-shrink: 0;
  border-radius: ${radius.control};
  background-color: ${color.skeletonBase};
  background-image: linear-gradient(
    90deg,
    ${color.skeletonBase} 0%,
    ${color.skeletonHighlight} 50%,
    ${color.skeletonBase} 100%
  );
  background-size: 300% 100%;
  animation: ${shimmer} ${durationValue.shimmerCycle} linear infinite;

  &[data-shape='circle'] {
    border-radius: ${radius.round};
  }

  ${media.reducedMotion} {
    animation: none;
    background-image: none;
  }

  ${media.forcedColors} {
    border: ${size.borderWidth} solid GrayText;
  }
`;

const TextLine = styled.span`
  display: flex;
  align-items: center;
`;

/**
 * A placeholder shape shown while data loads. Hidden from screen readers;
 * wrap placeholders in `LoadingPlaceholder` to announce the loading state.
 */
export function Skeleton({ shape = 'text', width = 'full', textSize = 'body', height }: SkeletonProps) {
  if (shape === 'text') {
    return (
      <TextLine aria-hidden="true" style={{ height: `calc(${fontSize[textSize]} * ${lineHeight.body})` }}>
        <Placeholder data-shape="text" style={{ width: WIDTHS[width], height: `calc(${fontSize[textSize]} * 0.9)` }} />
      </TextLine>
    );
  }

  if (shape === 'circle') {
    const diameter = height ?? space[7];
    return <Placeholder aria-hidden="true" data-shape="circle" style={{ width: diameter, height: diameter }} />;
  }

  return (
    <Placeholder aria-hidden="true" data-shape="block" style={{ width: WIDTHS[width], height: height ?? space[7] }} />
  );
}

export interface LoadingPlaceholderProps {
  /** What is loading, read by screen readers, for example the section name. */
  label: string;
  /** `Skeleton` shapes laid out like the content that will replace them. */
  children: ReactNode;
}

const LoadingGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${space[2]};
`;

/**
 * Groups skeletons and announces `label` once through a polite live region,
 * so the placeholder shapes themselves stay silent.
 */
export function LoadingPlaceholder({ label, children }: LoadingPlaceholderProps) {
  return (
    <LoadingGroup role="status" data-loading-placeholder="">
      <VisuallyHidden>{label}</VisuallyHidden>
      {children}
    </LoadingGroup>
  );
}
