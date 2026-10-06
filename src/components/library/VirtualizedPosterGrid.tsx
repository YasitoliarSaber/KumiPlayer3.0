import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import PosterCard from './PosterCard';
import { useUiStore } from '../../stores/ui';
import { calculatePosterGridMetrics } from './posterGridMetrics';
import { PosterImageContext, PosterImageLifecycle } from './posterImageLifecycle';
import { recordScrollDiagnostic } from '../../utils/scrollDiagnostics';

interface VirtualizedPosterGridProps {
  works: any[];
  columns: number;
  recentLabel?: string;
  localArtworkOnly?: boolean;
}

// 视口上下各预渲染的行数。第一版固定值：不做滚动速度预测与动态 overscan。
const OVERSCAN_ROWS = 6;

// 卡片宽度与屏幕缩放共同决定固定档位。
function pickThumbnailWidth(cssWidth: number, horizontal: boolean): number {
  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1
  const deviceWidth = Math.ceil(cssWidth * dpr)
  if (horizontal) return deviceWidth <= 512 ? 512 : 768
  if (deviceWidth <= 256) return 256
  if (deviceWidth <= 384) return 384
  return 512
}

export default function VirtualizedPosterGrid({
  works,
  columns,
  recentLabel = '',
  localArtworkOnly = false,
}: VirtualizedPosterGridProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // 真正的滚动容器是外层 .app-main：网格本身绝不能变成第二个滚动区域。
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const imageLifecycle = useMemo(() => new PosterImageLifecycle(), []);
  // P0-5：字段选择器订阅（避免 UI store 其他字段变化触发网格重渲染）
  const seriesCardImageMode = useUiStore((state) => state.seriesCardImageMode);
  const requestedColumns = Math.max(1, Math.round(columns || 1));
  const [effectiveColumns, setEffectiveColumns] = useState(requestedColumns);
  const [columnWidth, setColumnWidth] = useState(0);
  const [rowHeight, setRowHeight] = useState(0);
  const [gridGap, setGridGap] = useState(0);
  // 作品墙顶部在滚动容器内容坐标中的位置（标题、数量、排序工具之后）。
  const [gridOffset, setGridOffset] = useState(0);

  useLayoutEffect(() => {
    let measureFrame = 0;
    const scrollContainer = wrapRef.current?.closest<HTMLElement>('.app-main') || null;
    scrollElementRef.current = scrollContainer;
    const currentViewportHeight = () => scrollContainer ? scrollContainer.clientHeight : window.innerHeight;

    const measure = () => {
      measureFrame = 0;
      const element = wrapRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const width = element.clientWidth || rect.width;
      // 隐藏窗口尚无有效尺寸时保留卡片壳，不能按假宽度请求图片。
      if (width <= 0) return;
      const gap = readGridGap(element);
      const metaHeight = readCssLength(element, '--poster-card-meta-height', 62);
      const metrics = calculatePosterGridMetrics({
        width,
        gap,
        requestedColumns,
        imageMode: seriesCardImageMode,
        metaHeight,
      });
      const measuredColumns = metrics.effectiveColumns;
      setEffectiveColumns((current) => current === measuredColumns ? current : measuredColumns);
      setColumnWidth(metrics.columnWidth);
      setRowHeight(metrics.rowHeight);
      setGridGap(gap);
      // 列表不是从滚动容器 0px 开始：虚拟化需要列表起点，否则可视窗口会整体偏移。
      if (scrollContainer) {
        const containerRect = scrollContainer.getBoundingClientRect();
        setGridOffset(Math.max(0, rect.top - containerRect.top + scrollContainer.scrollTop));
      }
      imageLifecycle.configure(scrollContainer, currentViewportHeight());
    };

    const requestMeasure = () => {
      if (measureFrame) return;
      measureFrame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('resize', requestMeasure);
    window.visualViewport?.addEventListener('resize', requestMeasure);

    let resolutionQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    const handleResolutionChange = () => {
      requestMeasure();
      resolutionQuery?.removeEventListener('change', handleResolutionChange);
      resolutionQuery = window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
      resolutionQuery?.addEventListener('change', handleResolutionChange);
    };
    resolutionQuery?.addEventListener('change', handleResolutionChange);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
      observer = new ResizeObserver(requestMeasure);
      observer.observe(wrapRef.current);
      // 作品墙上方的内容（新番更新区等）异步出现时会把它整体下移，需要重测起点。
      const above = scrollContainer?.firstElementChild;
      if (above && above !== wrapRef.current) observer.observe(above);
    }

    return () => {
      if (measureFrame) window.cancelAnimationFrame(measureFrame);
      observer?.disconnect();
      imageLifecycle.dispose();
      window.removeEventListener('resize', requestMeasure);
      window.visualViewport?.removeEventListener('resize', requestMeasure);
      resolutionQuery?.removeEventListener('change', handleResolutionChange);
    };
  }, [imageLifecycle, requestedColumns, seriesCardImageMode, works.length]);

  // 规则网格只做行虚拟化：行内仍由 CSS Grid 排布 effectiveColumns 张卡片。
  const rowCount = rowHeight > 0 ? Math.ceil(works.length / effectiveColumns) : 0;

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN_ROWS,
    scrollMargin: gridOffset,
    // 挂载时滚动容器可能已经在别处（返回分类页恢复位置），必须按真实 scrollTop 起步。
    initialOffset: () => scrollElementRef.current?.scrollTop ?? 0,
    getItemKey: (index) => index,
  });

  // 行高（列宽）变化后必须重新测量：虚拟化只在 count/scrollMargin 变化时自动失效测量缓存，
  // 宽度变化但列数不变（resize）时行数不变，必须显式 measure()，否则行位置与总高度会残留。
  const measuredRowHeightRef = useRef(0);
  useLayoutEffect(() => {
    if (rowHeight <= 0 || measuredRowHeightRef.current === rowHeight) return;
    measuredRowHeightRef.current = rowHeight;
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  const virtualRows = rowCount > 0 ? rowVirtualizer.getVirtualItems() : [];

  // 总高度与旧的自然流栅格一致：行距已含一个 gap，末尾不再重复。
  const totalHeight = rowCount > 0 ? Math.max(0, rowVirtualizer.getTotalSize() - gridGap) : 0;

  // 分类页卡片走派生缩略图，降低本地 w780 原图的解码与内存开销
  const thumbnailWidth = columnWidth > 0 ? pickThumbnailWidth(columnWidth, seriesCardImageMode === 'fanart') : 0;

  const firstRow = virtualRows.length > 0 ? virtualRows[0].index : -1;
  const lastRow = virtualRows.length > 0 ? virtualRows[virtualRows.length - 1].index : -1;
  let renderedCards = 0;
  for (const row of virtualRows) {
    renderedCards += Math.max(0, Math.min(effectiveColumns, works.length - row.index * effectiveColumns));
  }
  const virtualWindowRef = useRef('');
  // 仅当可视窗口真正变化时记录一条低频诊断（不逐帧、不写 React 状态）。
  useEffect(() => {
    const signature = `${firstRow}:${lastRow}:${rowCount}:${effectiveColumns}`;
    if (virtualWindowRef.current === signature) return;
    virtualWindowRef.current = signature;
    recordScrollDiagnostic('virtual-window', {
      firstRow,
      lastRow,
      renderedRows: virtualRows.length,
      renderedCards,
      totalRows: rowCount,
      totalWorks: works.length,
    });
  }, [effectiveColumns, firstRow, lastRow, renderedCards, rowCount, virtualRows.length, works.length]);

  return (
    <PosterImageContext.Provider value={imageLifecycle}>
    <div
      ref={wrapRef}
      className="virtual-poster-grid"
      style={{
        ['--category-columns' as string]: effectiveColumns,
      }}
    >
      <div className="virtual-poster-rows" style={{ height: `${totalHeight}px` }}>
        {virtualRows.map((virtualRow) => {
          const rowStart = virtualRow.index * effectiveColumns;
          return (
            <div
              key={virtualRow.key}
              data-row-index={virtualRow.index}
              className="virtual-poster-row"
              style={{
                height: `${rowHeight}px`,
                transform: `translateY(${virtualRow.start - gridOffset}px)`,
              }}
            >
              {works.slice(rowStart, rowStart + effectiveColumns).map((work) => (
                <PosterCard
                  key={`${work.source}:${work.work_id}`}
                  work={work}
                  recentLabel={recentLabel}
                  thumbnailWidth={thumbnailWidth}
                  deferImage={thumbnailWidth === 0}
                  managedImage
                  localArtworkOnly={localArtworkOnly}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
    </PosterImageContext.Provider>
  );
}

function readGridGap(element: HTMLElement) {
  const computed = window.getComputedStyle(element);
  const value = Number.parseFloat(computed.getPropertyValue('--virtual-grid-gap'));
  if (Number.isFinite(value) && value > 0) return value;
  return Math.max(22, Math.min(32, window.innerWidth * 0.0155));
}

function readCssLength(element: HTMLElement, property: string, fallback: number) {
  const value = Number.parseFloat(window.getComputedStyle(element).getPropertyValue(property));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
