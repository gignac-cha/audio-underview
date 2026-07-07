/**
 * TanStack Query key 계층 (스펙 §8.3):
 * `['crawlers']` / `['crawlers', id]` /
 * `['schedulers']` / `['schedulers', id]` /
 * `['schedulers', id, 'stages']` / `['schedulers', id, 'runs']`.
 */
export const queryKeys = {
  crawlers: ['crawlers'] as const,
  crawler: (id: string) => ['crawlers', id] as const,
  schedulers: ['schedulers'] as const,
  scheduler: (id: string) => ['schedulers', id] as const,
  schedulerStages: (id: string) => ['schedulers', id, 'stages'] as const,
  schedulerRuns: (id: string) => ['schedulers', id, 'runs'] as const,
} as const;
