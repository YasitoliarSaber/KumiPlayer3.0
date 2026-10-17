/**
 * 虚拟化海报墙（影视专用自有组件）。
 *
 * 沿用单主滚动区、按行虚拟化、可见区外有界 overscan：
 * 挂载卡片数只与可见行数和列数有关，不随作品总数线性增长。
 */

import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { WorkSummary } from '@/shared/api/service';
import { PosterCard } from '@/shared/ui/PosterCard';

export interface PosterGridProps {
  readonly works: readonly WorkSummary[];
  readonly onOpen: (workId: string) => void;
  readonly desiredColumns?: number;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly emptyLabel?: string;
  readonly imageMode?: 'poster' | 'fanart';
}

const MIN_CARD_WIDTH = 112;
const COLUMN_GAP = 16;
const ROW_GAP = 18;
// 海报卡固定 64px 文本区 + 8px 图文间距，必须与 PosterCard 一致。
const META_HEIGHT = 72;
const OVERSCAN = 2;

export function PosterGrid({
  works,
  onOpen,
  desiredColumns = 8,
  scrollRef,
  emptyLabel = '这个筛选下还没有作品',
  imageMode = 'poster',
}: PosterGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ width, scrollMargin }, setGeometry] = useState({ width: 0, scrollMargin: 0 });
  const [focusedWork, setFocusedWork] = useState<string | null>(null);
  const hasWorks = works.length > 0;

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }
    const measure = () => {
      const scrollElement = scrollRef.current;
      const nextWidth = element.clientWidth;
      const nextMargin = scrollElement
        ? element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop
        : 0;
      setGeometry((previous) => previous.width === nextWidth && Math.abs(previous.scrollMargin - nextMargin) < 0.5
        ? previous
        : { width: nextWidth, scrollMargin: nextMargin });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (scrollRef.current) observer.observe(scrollRef.current);
    measure();
    return () => observer.disconnect();
  }, [scrollRef, hasWorks]);

  const columns = resolveColumns(width, desiredColumns);
  const rowCount = Math.ceil(works.length / columns);
  const focusedIndex = useMemo(() => focusedWork ? works.findIndex((work) => work.id === focusedWork) : -1, [works, focusedWork]);
  const focusedRow = focusedIndex >= 0 ? Math.floor(focusedIndex / columns) : -1;
  const rangeExtractor = useCallback((range: Range) => {
    const rows = defaultRangeExtractor(range);
    return focusedRow >= 0 && !rows.includes(focusedRow) ? [...rows, focusedRow].sort((a, b) => a - b) : rows;
  }, [focusedRow]);
  const cardWidth = width > 0 ? (width - COLUMN_GAP * (columns - 1)) / columns : MIN_CARD_WIDTH;
  const rowHeight = Math.ceil(cardWidth * (imageMode === 'fanart' ? 9 / 16 : 3 / 2))
    + (imageMode === 'fanart' ? 52 : META_HEIGHT) + ROW_GAP;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    scrollMargin,
    overscan: OVERSCAN,
    rangeExtractor,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);
  useLayoutEffect(() => {
    // 改列导致卡片跨行重挂载时恢复同一作品的焦点，不移动滚动位置。
    if (!focusedWork || document.activeElement !== document.body) return;
    const button = [...(containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-work-id]') ?? [])]
      .find((element) => element.dataset.workId === focusedWork);
    button?.focus({ preventScroll: true });
  }, [columns, focusedWork]);

  if (works.length === 0) {
    return <p className="my-12 text-center text-[13px] text-muted-foreground">{emptyLabel}</p>;
  }

  const rows = virtualizer.getVirtualItems();
  const range = virtualizer.range;

  return (
    <div ref={containerRef} className="relative w-full" data-virtual-rows={rows.length} data-poster-columns={columns} data-poster-total={works.length}
      onFocusCapture={(event) => setFocusedWork((event.target as HTMLElement).closest<HTMLElement>('[data-work-id]')?.dataset.workId ?? null)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedWork(null); }}>
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {rows.map((row) => {
          const start = row.index * columns;
          const rowWorks = works.slice(start, start + columns);
          return (
            <div
              key={row.key}
              className="absolute inset-x-0 top-0 grid gap-x-4 pb-[18px]"
              style={{
                transform: `translateY(${row.start - scrollMargin}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {rowWorks.map((work) => (
                <PosterCard key={work.id} work={work} onOpen={onOpen} imageMode={imageMode} displayWidth={width > 0 ? cardWidth : 0}
                  priority={range && row.index >= range.startIndex && row.index <= range.endIndex ? 'visible'
                    : range && (virtualizer.scrollDirection === 'backward'
                      ? row.index < range.startIndex && row.index >= range.startIndex - OVERSCAN
                      : row.index > range.endIndex && row.index <= range.endIndex + OVERSCAN)
                      ? 'prefetch' : null} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 桌面窗口落实用户选定的 6–9 列；小窗口才按可读宽度降列。 */
export function resolveColumns(width: number, desired: number): number {
  const target = Number.isFinite(desired) ? Math.max(6, Math.min(9, Math.floor(desired))) : 8;
  if (width >= 600) return target;
  const byWidth = width > 0 ? Math.floor((width + COLUMN_GAP) / (MIN_CARD_WIDTH + COLUMN_GAP)) : 2;
  return Math.max(2, Math.min(target, byWidth));
}
