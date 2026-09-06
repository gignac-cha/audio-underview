import type { SVGProps } from 'react';

/**
 * 자체 완결 line 아이콘 세트 (외부 아이콘 폰트 의존 제거 — 개선 §2).
 * 1.75 stroke, currentColor. 크기는 `size`(기본 18)로 제어.
 */
export type IconName =
  | 'crawler'
  | 'scheduler'
  | 'plus'
  | 'trash'
  | 'arrowLeft'
  | 'edit'
  | 'sun'
  | 'moon'
  | 'grip'
  | 'chevronDown'
  | 'branch'
  | 'play'
  | 'copy'
  | 'close'
  | 'check'
  | 'terminal'
  | 'search'
  | 'alert'
  | 'signOut'
  | 'bolt';

const PATHS: Record<IconName, string> = {
  crawler:
    'M12 8v8M12 12h9M12 12H3M6 9l-3 3 3 3M18 9l3 3-3 3M12 3a3 3 0 0 0-3 3 3 3 0 0 0 6 0 3 3 0 0 0-3-3z',
  scheduler: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  arrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  chevronDown: 'M6 9l6 6 6-6',
  branch: 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 6c0 4-6 3-6 9',
  play: 'M6 4l14 8-14 8V4z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  close: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export const Icon = ({ name, size = 18, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden={rest['aria-label'] === undefined ? true : undefined}
    role={rest['aria-label'] === undefined ? undefined : 'img'}
    {...rest}
  >
    <path d={PATHS[name]} />
  </svg>
);
