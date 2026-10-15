/**
 * 海报卡：复刻当前应用的卡片层级（海报 → 评分角标 → 标题 → 副标题 → 进度条）。
 * 只展示已给定的展示数据，不推导作品事实。
 */

import { memo } from 'react';

import type { WorkSummary } from '../api/service';
import { Artwork } from './Artwork';
import { ProgressBar } from './Surface';
import styles from './PosterCard.module.css';

export interface PosterCardProps {
  readonly work: WorkSummary;
  /** 横向（继续观看）卡片显示剧集缩略图与剩余时间。 */
  readonly variant?: 'poster' | 'wide';
  readonly onOpen: (workId: string) => void;
  readonly eager?: boolean;
}

function PosterCardComponent({ work, variant = 'poster', onOpen, eager = false }: PosterCardProps) {
  const wide = variant === 'wide';
  const image = wide ? work.artwork.fanart ?? work.artwork.poster : work.artwork.poster;
  const percent =
    work.progress && work.progress.duration > 0
      ? (work.progress.position / work.progress.duration) * 100
      : work.progress?.completed
        ? 100
        : null;

  return (
    <button
      type="button"
      className={wide ? `${styles.card} ${styles.wide}` : styles.card}
      onClick={() => onOpen(work.id)}
      aria-label={`打开${work.title}详情`}
    >
      <span className={styles.media}>
        <Artwork
          artwork={image}
          alt={work.title}
          fallbackLabel={work.title}
          className={styles.image}
          loading={eager ? 'eager' : 'lazy'}
        />
        {wide ? null : work.rating > 0 ? <span className={styles.rating}>{work.rating.toFixed(1)}</span> : null}
        {work.watch.favorite ? (
          <span className={styles.favorite} title="已收藏">
            ♥
          </span>
        ) : null}
        {percent !== null && percent > 0 ? (
          <span className={styles.progress}>
            <ProgressBar value={percent} label={`${work.title}观看进度`} />
          </span>
        ) : null}
      </span>
      <span className={styles.meta}>
        <span className={styles.title} title={work.title}>
          {work.title}
        </span>
        <span className={styles.subtitle}>{subtitle(work, wide)}</span>
      </span>
    </button>
  );
}

function subtitle(work: WorkSummary, wide: boolean): string {
  if (wide) {
    const code = work.progress?.episodeCode ?? '';
    const remaining = remainingLabel(work);
    return [code, remaining].filter(Boolean).join(' · ') || '继续观看';
  }
  const seasonLabel =
    work.mediaType === 'movie' ? '' : work.seasonCount > 1 ? `共 ${work.seasonCount} 季` : '共 1 季';
  return [seasonLabel, work.year ? String(work.year) : ''].filter(Boolean).join(' · ');
}

/** 与当前应用一致的"还剩"文案：宁可高估，不多报。 */
export function remainingLabel(work: WorkSummary): string {
  const progress = work.progress;
  if (!progress) {
    return '';
  }
  if (progress.completed) {
    return '已看完 ✓';
  }
  const remaining = progress.duration - progress.position;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return '继续观看';
  }
  if (remaining < 60) {
    return '还剩不到 1 分钟';
  }
  const minutes = Math.max(1, Math.ceil(remaining / 60));
  if (minutes < 60) {
    return `还剩 ${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `还剩 ${hours} 小时` : `还剩 ${hours} 小时 ${rest} 分`;
}

export const PosterCard = memo(PosterCardComponent);
