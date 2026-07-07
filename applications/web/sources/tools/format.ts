/** 표시용 날짜/시간/기간 포맷 유틸. */

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export const formatDate = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date);
};

export const formatDateTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTimeFormatter.format(date);
};

/** started~completed 소요시간 → `Xms` / `X.Ys` / `Xm Ys`. */
export const formatDuration = (
  startedAt: string | null,
  completedAt: string | null,
): string => {
  if (startedAt === null || completedAt === null) {
    return '-';
  }
  const milliseconds = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(milliseconds) || milliseconds < 0) {
    return '-';
  }
  if (milliseconds < 1000) {
    return `${String(milliseconds)}ms`;
  }
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${String(minutes)}m ${String(remainingSeconds)}s`;
};
