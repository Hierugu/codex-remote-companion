import type { PropsWithChildren, ReactNode } from 'react';

interface SectionCardProps extends PropsWithChildren {
  title: string;
  action?: ReactNode;
  className?: string;
  scrollContent?: boolean;
}

export function SectionCard({
  title,
  action,
  className,
  scrollContent = false,
  children
}: SectionCardProps) {
  return (
    <section className={className ? `section-card ${className}` : 'section-card'}>
      <div className={scrollContent ? 'section-card__scroll' : undefined}>
        <div className="section-card__header">
          <h2>{title}</h2>
          {action}
        </div>
        <div className="section-card__body">{children}</div>
      </div>
    </section>
  );
}
