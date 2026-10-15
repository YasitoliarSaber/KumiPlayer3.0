/**
 * 虚拟化海报墙。
 *
 * 沿用当前应用的单主滚动区、按行虚拟化、可见区外有界 overscan；
 * 卡片数量只与可见行数和列数有关，不随作品总数线性增长。
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

import type { WorkSummary } from '../api/service';
import { PosterCard } from './PosterCard';
import styles from './PosterGrid.module.css';

export interface PosterGridProps {
  readonly works: readonly WorkSummary[];
  readonly onOpen: (workId: string) => void;
  /** 期望列数（对应现有应用的海报墙密度设置）。 */
  readonly desiredColumns?: number;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly emptyLabel?: string;
}

const MIN_CARD_WIDTH = 150;
const GAP = 18;
const META_HEIGHT = 52;
const OVERSCAN = 2;

export function PosterGrid({
  works,
  onOpen,
  desiredColumns = 8,
  scrollRef,
  emptyLabel = '这个筛选下还没有作品',
}: PosterGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = resolveColumns(width, desiredColumns);
  const rowCount = Math.ceil(works.length / columns);
  const cardWidth = width > 0 ? (width - GAP * (columns - 1)) / columns : MIN_CARD_WIDTH;
  const rowHeight = Math.round((cardWidth * 3) / 2) + META_HEIGHT + GAP;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  });

  // 行高随容器宽度变化时必须重新测量，否则会出现空白或跳动。
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, columns, virtualizer]);

  if (works.length === 0) {
    return <p className={styles.empty}>{emptyLabel}</p>;
  }

  const rows = virtualizer.getVirtualItems();

  return (
    <div ref={containerRef} className={styles.wrap} data-virtual-rows={rows.length}>
      <div className={styles.viewport} style={{ height: virtualizer.getTotalSize() }}>
        {rows.map((row) => {
          const start = row.index * columns;
          const rowWorks = works.slice(start, start + columns);
          return (
            <div
              key={row.key}
              className={styles.row}
              style={{
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {rowWorks.map((work) => (
                <PosterCard key={work.id} work={work} onOpen={onOpen} eager={row.index <= 1} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 列数由容器宽度决定，并受现有"海报墙密度"设置限制。 */
export function resolveColumns(width: number, desired: number): number {
  const byWidth = width > 0 ? Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP)) : 2;
  return Math.max(2, Math.min(desired, Math.max(byWidth, 2)));
}
