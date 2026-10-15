/**
 * 海报卡（影视专用自有组件）：海报 → 评分 → 收藏 → 进度 → 标题 → 副标题。
 * 只展示已给定的展示数据，不推导作品事实。
 */

import { memo } from 'react';

import type { WorkSummary } from '@/shared/api/service';
import { cn } from '@/shared/lib/utils';
import { Artwork } from '@/shared/ui/Artwork';
import { ProgressBar } from '@/shared/ui/Surface';

export interface PosterCardProps {
  readonly work: WorkSummary;
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
      onClick={() => onOpen(work.id)}
      aria-label={`打开${work.title}详情`}
      className="group flex flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-lg bg-[var(--surface-soft)] ring-1 ring-inset ring-[var(--border)]',
          'transition-shadow duration-150 group-hover:ring-[var(--border-strong)]',
          wide ? 'aspect-video' : 'aspect-[2/3]',
        )}
      >
        <Artwork
          artwork={image}
          alt={work.title}
          fallbackLabel={work.title}
          className="size-full object-cover"
          loading={eager ? 'eager' : 'lazy'}
        />
        {!wide && work.rating > 0 ? (
          <span className="absolute top-2 right-2 rounded-full bg-black/65 px-2 py-0.5 text-[12px] font-semibold text-white">
            {work.rating.toFixed(1)}
          </span>
        ) : null}
        {work.watch.favorite ? (
          <span
            className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/55 text-[13px] text-rose-400"
            title="已收藏"
            aria-hidden="true"
          >
            ♥
          </span>
        ) : null}
        {percent !== null && percent > 0 ? (
          <span className="absolute inset-x-0 bottom-0">
            <ProgressBar value={percent} label={`${work.title}观看进度`} />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="line-clamp-2 text-[13.5px] leading-tight font-semibold text-foreground group-hover:text-[var(--accent-strong)]">
          {work.title}
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{subtitle(work, wide)}</span>
      </span>
    </button>
  );
}

function subtitle(work: WorkSummary, wide: boolean): string {
  if (wide) {
    const code = work.progress?.episodeCode ?? '';
    return [code, remainingLabel(work)].filter(Boolean).join(' · ') || '继续观看';
  }
  const seasonLabel = work.mediaType === 'movie' ? '' : work.seasonCount > 1 ? `共 ${work.seasonCount} 季` : '共 1 季';
  return [seasonLabel, work.year ? String(work.year) : ''].filter(Boolean).join(' · ');
}

/** 与当前产品一致的"还剩"文案：宁可高估，不多报。 */
export function remainingLabel(work: WorkSummary): string {
  const progress = work.progress;
  if (!progress) {
    return '';
  }
  if (progress.completed) {
    return '已看完';
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
