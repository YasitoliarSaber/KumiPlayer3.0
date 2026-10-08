export type PosterGridImageMode = 'poster' | 'fanart';

/** 作品墙目标列数的偏好范围：作为布局偏好上下界，与内部 availableColumns 无关。 */
const MIN_POSTER_COLUMNS = 5;
const MAX_POSTER_COLUMNS = 9;

/**
 * 把持久化的封面大小偏好归一化为目标列数。
 *
 * 5~9 直接作为目标列数；旧 3/4 列与 170 及以上的像素偏好归入 5 列，
 * 其余回退到 6 列。窄窗口容量由 calculatePosterGridMetrics 单独处理。
 */
export function normalizePosterColumns(value: number) {
  if (Number.isFinite(value) && value > 0 && value <= MAX_POSTER_COLUMNS) {
    return Math.max(MIN_POSTER_COLUMNS, Math.min(MAX_POSTER_COLUMNS, Math.round(value)));
  }
  if (value >= 170) return 5;
  return 6;
}

interface PosterGridMetricsInput {
  width: number;
  gap: number;
  requestedColumns: number;
  imageMode: PosterGridImageMode;
  metaHeight: number;
}

export interface PosterGridMetrics {
  columnCapacity: number;
  effectiveColumns: number;
  columnWidth: number;
  rowHeight: number;
}

const MIN_CARD_WIDTH: Record<PosterGridImageMode, number> = {
  poster: 140,
  fanart: 190,
};

export function calculatePosterGridMetrics({
  width,
  gap,
  requestedColumns,
  imageMode,
  metaHeight,
}: PosterGridMetricsInput): PosterGridMetrics {
  const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
  const safeGap = Math.max(0, Number.isFinite(gap) ? gap : 0);
  const safeMetaHeight = Math.max(0, Number.isFinite(metaHeight) ? metaHeight : 0);
  const safeRequestedColumns = Math.max(1, Math.round(requestedColumns || 1));
  const minimumCardWidth = MIN_CARD_WIDTH[imageMode];
  const availableColumns = Math.max(
    1,
    Math.floor((safeWidth + safeGap) / (minimumCardWidth + safeGap)),
  );
  const effectiveColumns = Math.min(safeRequestedColumns, availableColumns);
  const columnWidth = Math.max(
    1,
    (safeWidth - safeGap * (effectiveColumns - 1)) / effectiveColumns,
  );
  const mediaHeight = imageMode === 'fanart'
    ? columnWidth * 9 / 16
    : columnWidth * 3 / 2;

  return {
    columnCapacity: availableColumns,
    effectiveColumns,
    columnWidth,
    rowHeight: mediaHeight + safeMetaHeight + safeGap,
  };
}
