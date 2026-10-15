/**
 * 页面级状态与通用小件：加载 / 空 / 失败 / 进度条 / 分区标题。
 * 只提供状态表达，不承担任何媒体业务判断。
 */

import { Button, Loader } from '@mantine/core';
import type { ReactNode } from 'react';

import styles from './Surface.module.css';

export function LoadingSurface({ label, detail }: { readonly label: string; readonly detail?: string }) {
  return (
    <div className={styles.state} role="status" aria-live="polite">
      <Loader size="md" />
      <p className={styles.title}>{label}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
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
    <div className={styles.state}>
      {kicker ? <span className={styles.kicker}>{kicker}</span> : null}
      <p className={styles.title}>{title}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
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
    <div className={styles.state} role="alert">
      <p className={styles.title}>{title}</p>
      {detail ? <p className={styles.detail}>{detail}</p> : null}
      {onRetry ? (
        <div className={styles.action}>
          <Button variant="default" onClick={onRetry}>
            重新加载
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProgressBar({
  value,
  label,
  size = 3,
}: {
  /** 0..100；未知进度传 null，渲染为不确定态。 */
  readonly value: number | null;
  readonly label?: string;
  readonly size?: number;
}) {
  return (
    <span
      className={styles.progress}
      style={{ height: size }}
      role="progressbar"
      aria-label={label}
      {...(value === null ? {} : { 'aria-valuenow': Math.round(value), 'aria-valuemin': 0, 'aria-valuemax': 100 })}
    >
      <span
        className={value === null ? styles.progressIndeterminate : styles.progressValue}
        style={value === null ? undefined : { width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  );
}

export function SectionHeading({
  title,
  meta,
  action,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className={styles.heading}>
      <h2 className={styles.headingTitle}>
        {title}
        {meta ? <span className={styles.headingMeta}>{meta}</span> : null}
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
  return <span className={`${styles.chip} ${styles[`chip_${tone}`]}`}>{children}</span>;
}
