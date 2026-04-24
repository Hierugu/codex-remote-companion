import type { StatusBadgeState } from '@shared/contracts';

interface StatusPillProps {
  status?: StatusBadgeState;
  className?: string;
  isLoading?: boolean;
}

export function StatusPill({ status, className, isLoading = false }: StatusPillProps) {
  const safeStatus = status ?? { tone: 'red', text: 'Unknown' };
  const classes = [
    'status-pill',
    `status-pill--${safeStatus.tone}`,
    isLoading ? 'status-pill--loading' : null,
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      <span
        className={isLoading ? 'wave-text' : undefined}
        data-text={isLoading ? safeStatus.text : undefined}
      >
        {safeStatus.text}
      </span>
    </span>
  );
}
