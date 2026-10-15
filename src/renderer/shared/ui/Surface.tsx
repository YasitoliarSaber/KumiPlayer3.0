/**
 * 页面级状态与通用小件：加载 / 空 / 失败 / 进度条 / 分区标题 / 状态标签。
 * 使用 shadcn/ui 组件与 Tailwind；只表达状态，不承担任何媒体业务判断。
 */

import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';

export function LoadingSurface({ label, detail }: { readonly label: string; readonly detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center" role="status" aria-live="polite">
      <Skeleton className="size-8 rounded-full" />
      <p className="text-[15px] font-semibold text-foreground">{label}</p>
      {detail ? <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

export function EmptySurface({
  kicker,
  title,
  detail,
  action,
}: {
  readonly kicker?: string;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center">
      {kicker ? <span className="text-[11.5px] tracking-[0.14em] text-muted-foreground">{kicker}</span> : null}
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {detail ? <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorSurface({
  title = '加载失败',
  detail,
  onRetry,
}: {
  readonly title?: string;
  readonly detail?: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center" role="alert">
      <p className="text-[15px] font-semibold text-foreground">{title}</p>
      {detail ? <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
          重新加载
        </Button>
      ) : null}
    </div>
  );
}

export function ProgressBar({
  value,
  label,
  size = 3,
  className,
}: {
  readonly value: number | null;
  readonly label?: string;
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <span
      className={cn('block w-full overflow-hidden rounded-full bg-foreground/15', className)}
      style={{ height: size }}
      role="progressbar"
      aria-label={label}
      {...(value === null ? {} : { 'aria-valuenow': Math.round(value), 'aria-valuemin': 0, 'aria-valuemax': 100 })}
    >
      <span
        className={cn('block h-full rounded-full bg-primary', value === null && 'w-2/5 animate-pulse')}
        style={value === null ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  );
}

export function SectionHeading({
  title,
  meta,
  action,
  className,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('mb-3 flex items-end justify-between gap-3', className)}>
      <h2 className="flex items-baseline gap-2.5 text-[17px] font-semibold text-foreground">
        {title}
        {meta ? <span className="text-[12.5px] font-normal text-muted-foreground">{meta}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function StatusChip({
  tone = 'neutral',
  children,
}: {
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  readonly children: ReactNode;
}) {
  const variant =
    tone === 'success'
      ? 'success'
      : tone === 'warning'
        ? 'warning'
        : tone === 'danger'
          ? 'danger'
          : tone === 'info'
            ? 'soft'
            : 'outline';
  return <Badge variant={variant}>{children}</Badge>;
}
