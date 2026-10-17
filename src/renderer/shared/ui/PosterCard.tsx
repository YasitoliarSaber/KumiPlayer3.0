/**
 * 海报卡（影视领域组件）：图片、标题与副标题。
 * 图片面保持干净，不叠加进度、评分、徽标、滤镜或渐变文字；
 * 大量海报同时渲染时，避免逐卡叠加层与悬停重绘造成卡顿。
 * 只展示已给定的展示数据，不推导作品事实。
 */

import { memo } from 'react';

import type { WorkSummary } from '@/shared/api/service';
import { cn } from '@/shared/lib/utils';
import { Artwork } from '@/shared/ui/Artwork';
import type { ArtworkPriority } from '@/shared/ui/artwork-lifecycle';
import { ProgressBar } from '@/shared/ui/Surface';

export interface PosterCardProps {
  readonly work: WorkSummary;
  readonly variant?: 'poster' | 'wide';
  readonly onOpen: (workId: string) => void;
  readonly eager?: boolean;
  readonly imageMode?: 'poster' | 'fanart';
  readonly displayWidth?: number;
  readonly priority?: ArtworkPriority | null;
  /** 分类墙可关闭副标题；继续观看仍保留进度文字与进度条。 */
  readonly showSubtitle?: boolean;
}

function PosterCardComponent({
  work,
  variant = 'poster',
  onOpen,
  eager = false,
  imageMode = 'poster',
  displayWidth,
  priority,
  showSubtitle = true,
}: PosterCardProps) {
  const wide = variant === 'wide';
  const landscape = wide || imageMode === 'fanart';
  const image = landscape ? work.artwork.fanart ?? work.artwork.poster : work.artwork.poster;
  const percent =
    work.progress?.completed
      ? 100
      : work.progress && work.progress.duration > 0
        ? (work.progress.position / work.progress.duration) * 100
        : null;

  return (
    <button
      type="button"
      data-work-id={work.id}
      onClick={() => onOpen(work.id)}
      aria-label={`打开${work.title}详情`}
      className="flex min-w-0 flex-col gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span
        className={cn(
          'relative block overflow-hidden rounded-lg',
          landscape ? 'aspect-video' : 'aspect-[2/3]',
        )}
      >
        <Artwork
          artwork={image}
          alt={work.title}
          fallbackLabel={work.title}
          className="size-full object-cover"
          loading={eager ? 'eager' : 'lazy'}
          displayWidth={displayWidth}
          priority={priority}
        />
      </span>
      <span className={cn(
        'flex w-full min-w-0 flex-col gap-1',
        showSubtitle ? (wide ? 'h-14' : landscape ? 'h-11' : 'h-16') : 'h-[2.7em]',
      )}>
        <span className={cn(
          'text-[14px] leading-[1.35] font-semibold text-foreground',
          landscape ? 'line-clamp-1 h-[1.35em]' : 'line-clamp-2 h-[2.7em]',
        )} title={work.title}>
          {work.title}
        </span>
        {showSubtitle ? (
          <span className="truncate text-[12px] text-muted-foreground">{subtitle(work, wide)}</span>
        ) : null}
        {wide && percent !== null && percent > 0 ? (
          <ProgressBar value={percent} label={`${work.title}观看进度`} size={3} className="mt-auto" />
        ) : null}
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
  return seasonLabel;
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
