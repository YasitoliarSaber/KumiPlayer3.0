import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import VirtualizedPosterGrid from '../../src/components/library/VirtualizedPosterGrid';
import { useUiStore } from '../../src/stores/ui';
import { api } from '../../src/api/client';
import { disableScrollDiagnostics, dumpScrollDiagnostics, enableScrollDiagnostics } from '../../src/utils/scrollDiagnostics';

vi.mock('../../src/api/client', () => ({ API_BASE: '', api: { post: vi.fn() } }));

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 900;
const COLUMNS = 4;
/** 组件内固定的视口外预渲染行数（不做速度预测）。 */
const OVERSCAN_ROWS = 6;
/** 由测试注入到 :root 的网格变量，让行距期望值可精确计算。 */
const GRID_GAP = 24;
const META_HEIGHT = 62;

const work = (index: number) => ({
  work_id: `w${index}`, title: `作品${index}`, source: 'local',
  show_type: 'anime_series', local_poster_path: `D:/mirror/${index}/poster.jpg`, rating: 8,
});

const works = (count: number) => Array.from({ length: count }, (_, index) => work(index));

/** 与 posterGridMetrics 的公开公式一致；该公式本身由 tests/poster-grid-metrics.test.ts 锁定。 */
function expectedRowHeight(columns: number, ratio: 'poster' | 'fanart' = 'poster') {
  const columnWidth = (VIEWPORT_WIDTH - GRID_GAP * (columns - 1)) / columns;
  const mediaHeight = ratio === 'fanart' ? columnWidth * 9 / 16 : columnWidth * 3 / 2;
  return mediaHeight + META_HEIGHT + GRID_GAP;
}

let styleElement: HTMLStyleElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.post).mockImplementation(async (_path, body: any) => ({ states: body.items.map(() => 'ready') }));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: VIEWPORT_WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: VIEWPORT_HEIGHT });
  // 虚拟化按 offsetWidth/offsetHeight 读取滚动视口尺寸（jsdom 无布局）。
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: VIEWPORT_WIDTH });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: VIEWPORT_HEIGHT });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: VIEWPORT_WIDTH, top: 0 } as DOMRect);
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  styleElement = document.createElement('style');
  styleElement.textContent = `:root { --virtual-grid-gap: ${GRID_GAP}px; --poster-card-meta-height: ${META_HEIGHT}px; }`;
  document.head.append(styleElement);
  useUiStore.setState({ seriesCardImageMode: 'poster' });
});

afterEach(() => {
  styleElement.remove();
  disableScrollDiagnostics({ persist: false });
});

function scrollMainTo(top: number) {
  const main = document.querySelector<HTMLElement>('.app-main')!;
  main.scrollTop = top;
  act(() => { fireEvent.scroll(main); });
}

function renderedRows() {
  return [...document.querySelectorAll<HTMLElement>('.virtual-poster-row')].map((row) => ({
    index: Number(row.dataset.rowIndex),
    height: Number.parseFloat(row.style.height),
    top: Number.parseFloat(/translateY\((-?[\d.]+)px\)/.exec(row.style.transform)?.[1] ?? 'NaN'),
    titles: [...row.querySelectorAll('.poster-card-title')].map((node) => node.textContent ?? ''),
  }));
}

function spacerHeight() {
  return Number.parseFloat(document.querySelector<HTMLElement>('.virtual-poster-rows')!.style.height);
}

test('大量作品只渲染可视窗口与 overscan 行，不再全量挂载卡片', () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={works(200)} columns={COLUMNS} /></main>);

  const rows = renderedRows();
  const cards = [...document.querySelectorAll('.poster-card')];
  const rowHeight = expectedRowHeight(COLUMNS);
  const viewportRows = Math.ceil(VIEWPORT_HEIGHT / rowHeight);

  expect(rows[0].height).toBeCloseTo(rowHeight, 5);
  // 关键：200 部作品不再对应 200 个卡片 DOM。
  expect(cards).toHaveLength(rows.length * COLUMNS);
  expect(cards.length).toBeLessThan(200);
  // 只保留可视行 + 上下 overscan：900px 视口 / 行距 ~434px → 3 行可视 + 6 行 overscan = 9 行 36 张卡。
  expect(rows).toHaveLength(viewportRows + OVERSCAN_ROWS);
  expect(cards).toHaveLength((viewportRows + OVERSCAN_ROWS) * COLUMNS);
  // 首屏从第一行开始，渲染范围必须覆盖整个视口（不能出现空白带）。
  expect(rows[0].index).toBe(0);
  expect((rows[rows.length - 1].index + 1) * rowHeight).toBeGreaterThanOrEqual(VIEWPORT_HEIGHT);
  // 渲染范围有界：视口行数 + 上下 overscan。
  expect(rows.length).toBeLessThanOrEqual(viewportRows + 2 * OVERSCAN_ROWS + 1);
  // 行位置按行距排布，行与行不重叠。
  rows.forEach((row, position) => {
    expect(row.top).toBeCloseTo(row.index * rowHeight, 5);
    if (position > 0) expect(rows[position - 1].top + rows[position - 1].height).toBeLessThanOrEqual(row.top);
  });
  // 总高度与自然流栅格一致：行数 × 行距 − 末尾多余的 gap。
  expect(spacerHeight()).toBeCloseTo(200 / COLUMNS * rowHeight - GRID_GAP, 3);
});

test('滚动后只保留窗口所在行，作品顺序与索引严格对应', () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={works(200)} columns={COLUMNS} /></main>);
  const rowHeight = expectedRowHeight(COLUMNS);
  const targetRow = 20;
  scrollMainTo(targetRow * rowHeight);

  const rows = renderedRows();
  const viewportRows = Math.ceil(VIEWPORT_HEIGHT / rowHeight);
  expect(rows[0].index).toBeGreaterThanOrEqual(targetRow - OVERSCAN_ROWS - 1);
  expect(rows[0].index).toBeLessThanOrEqual(targetRow);
  expect(rows[rows.length - 1].index).toBeGreaterThanOrEqual(targetRow + viewportRows - 1);
  expect(rows[rows.length - 1].index).toBeLessThanOrEqual(targetRow + viewportRows + OVERSCAN_ROWS);
  expect(document.querySelectorAll('.poster-card').length).toBeLessThan(200);
  // 窗口内的卡片顺序与输入作品顺序一致，没有错位或重复。
  for (const row of rows) {
    expect(row.titles).toEqual(Array.from({ length: COLUMNS }, (_, column) => `作品${row.index * COLUMNS + column}`));
  }
});

test('滚动到末尾时最后一行不足列数保持左对齐且不丢作品', () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={works(10)} columns={COLUMNS} /></main>);
  const rowHeight = expectedRowHeight(COLUMNS);
  scrollMainTo(1000 * rowHeight);

  const rows = renderedRows();
  expect(rows.map((row) => row.index)).toEqual([0, 1, 2]);
  expect(rows[0].titles).toEqual(['作品0', '作品1', '作品2', '作品3']);
  expect(rows[1].titles).toEqual(['作品4', '作品5', '作品6', '作品7']);
  expect(rows[2].titles).toEqual(['作品8', '作品9']);
  expect(document.querySelectorAll('.poster-card')).toHaveLength(10);
  expect(spacerHeight()).toBeCloseTo(3 * rowHeight - GRID_GAP, 3);
});

test('列数变化后按新列数重新切分，行距与总高度同步重算', () => {
  const { rerender } = render(<main className="app-main"><VirtualizedPosterGrid works={works(12)} columns={COLUMNS} /></main>);
  const wideRows = renderedRows();
  expect(wideRows).toHaveLength(3);
  expect(wideRows[0].height).toBeCloseTo(expectedRowHeight(COLUMNS), 5);

  rerender(<main className="app-main"><VirtualizedPosterGrid works={works(12)} columns={2} /></main>);
  const narrowRows = renderedRows();
  const narrowRowHeight = expectedRowHeight(2);
  expect(narrowRows).toHaveLength(6);
  // 列数减少 → 列宽与行距变大，不能用旧行距残留布局。
  expect(narrowRows[0].height).toBeCloseTo(narrowRowHeight, 5);
  narrowRows.forEach((row, position) => {
    expect(row.titles).toEqual([`作品${row.index * 2}`, `作品${row.index * 2 + 1}`]);
    expect(row.top).toBeCloseTo(row.index * narrowRowHeight, 5);
    if (position > 0) expect(narrowRows[position - 1].top + narrowRows[position - 1].height).toBeLessThanOrEqual(row.top);
  });
  expect(spacerHeight()).toBeCloseTo(6 * narrowRowHeight - GRID_GAP, 3);
});

test('切换 fanart 后行高重新测量，横版行距小于竖版且行不重叠', () => {
  const { rerender } = render(<main className="app-main"><VirtualizedPosterGrid works={works(12)} columns={COLUMNS} /></main>);
  const posterRowHeight = expectedRowHeight(COLUMNS);
  expect(renderedRows()[0].height).toBeCloseTo(posterRowHeight, 5);

  act(() => { useUiStore.setState({ seriesCardImageMode: 'fanart' }); });
  rerender(<main className="app-main"><VirtualizedPosterGrid works={works(12)} columns={COLUMNS} /></main>);
  const fanartRows = renderedRows();
  const fanartRowHeight = expectedRowHeight(COLUMNS, 'fanart');

  expect(fanartRows).toHaveLength(3);
  expect(fanartRows[0].height).toBeCloseTo(fanartRowHeight, 5);
  expect(fanartRowHeight).toBeLessThan(posterRowHeight);
  fanartRows.forEach((row, position) => {
    expect(row.top).toBeCloseTo(row.index * fanartRowHeight, 5);
    if (position > 0) expect(fanartRows[position - 1].top + fanartRows[position - 1].height).toBeLessThanOrEqual(row.top);
  });
  // 行距变化后总高度必须跟着变，否则会出现空白或滚动不到底。
  expect(spacerHeight()).toBeCloseTo(3 * fanartRowHeight - GRID_GAP, 3);
});

test('虚拟窗口变化写入低频诊断，可用真实 DOM 数量证明虚拟化生效', () => {
  enableScrollDiagnostics({ persist: false });
  render(<main className="app-main"><VirtualizedPosterGrid works={works(200)} columns={COLUMNS} /></main>);
  scrollMainTo(30 * expectedRowHeight(COLUMNS));

  const windows = dumpScrollDiagnostics({ includeEvents: true }).events
    .filter((event) => event.kind === 'virtual-window');
  expect(windows.length).toBeGreaterThanOrEqual(2);
  const latest = windows[windows.length - 1].data!;
  expect(latest.totalWorks).toBe(200);
  expect(latest.totalRows).toBe(Math.ceil(200 / COLUMNS));
  expect(latest.renderedCards).toBeLessThan(200);
  expect(latest.renderedRows).toBe(latest.lastRow! - latest.firstRow! + 1);
  expect(document.querySelectorAll('.poster-card')).toHaveLength(latest.renderedCards!);
});
