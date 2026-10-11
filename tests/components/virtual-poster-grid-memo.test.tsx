import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import VirtualizedPosterGrid from '../../src/components/library/VirtualizedPosterGrid';
import { api } from '../../src/api/client';

vi.mock('../../src/api/client', () => ({ API_BASE: '', api: { post: vi.fn() } }));
let callbacks: IntersectionObserverCallback[] = [];
const observed = new Set<HTMLImageElement>();
let observer: IntersectionObserver;
const observe = vi.fn((node: HTMLImageElement) => observed.add(node));
const disconnect = vi.fn();
const artworkPath = (resourceHex: string, digestHex: string, width = 256) =>
  `/api/assets/artwork/${resourceHex.repeat(64)}/${digestHex.repeat(64)}-webp-v1/${width}`;
const work = (index: number) => ({
  work_id: `w${index}`, title: `作品${index}`, source: 'local',
  show_type: 'anime_series', local_poster_path: artworkPath((index % 10).toString(16), '1'), rating: 8,
});
afterEach(() => { for (let count = 0; count < 2; count++) observed.forEach((node) => fireEvent.load(node)); observed.clear(); vi.useRealTimers(); });

beforeEach(() => {
  vi.clearAllMocks(); callbacks = [];
  vi.mocked(api.post).mockImplementation(async (_path, body: any) => ({ states: body.items.map(() => 'ready') }));
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 900 });
  // 行虚拟化按 offsetHeight 判断滚动视口尺寸（jsdom 无布局，必须显式提供）。
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1000 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, top: 0 } as DOMRect);
  vi.stubGlobal('IntersectionObserver', class {
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
    constructor(cb: IntersectionObserverCallback) { callbacks.push(cb); observer = this as unknown as IntersectionObserver; }
  });
});

function intersect(images: HTMLImageElement[], visible: boolean, region = 0) {
  act(() => callbacks[callbacks.length - 3 + region](images.map((target) => ({ target, isIntersecting: visible } as unknown as IntersectionObserverEntry)), observer));
}

test('窗口未变化的滚动不重建卡片节点，也不逐帧提交 React 更新', () => {
  const onRender = vi.fn();
  render(<main className="app-main"><Profiler id="grid" onRender={onRender}>
    <VirtualizedPosterGrid works={Array.from({ length: 8 }, (_, i) => work(i))} columns={4} />
  </Profiler></main>);
  const before = [...document.querySelectorAll('.poster-card')];
  expect(before).toHaveLength(8);
  const main = document.querySelector<HTMLElement>('.app-main')!;
  // 8 部作品全部落在可视窗口 + overscan 内：首次滚动只翻转滚动状态，窗口不变。
  main.scrollTop = 1;
  fireEvent.scroll(main);
  onRender.mockClear();
  for (const top of [40, 120, 0]) { main.scrollTop = top; fireEvent.scroll(main); }
  expect(onRender).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('.poster-card')]).toEqual(before);
});

test('同一批快速跨行滚动只提交最终窗口，不在每个滚动事件强制同步渲染', () => {
  const onRender = vi.fn();
  render(<main className="app-main"><Profiler id="grid" onRender={onRender}>
    <VirtualizedPosterGrid works={Array.from({ length: 400 }, (_, i) => work(i))} columns={4} />
  </Profiler></main>);
  const main = document.querySelector<HTMLElement>('.app-main')!;
  onRender.mockClear();
  act(() => {
    for (const top of [3000, 6000, 9000, 12000, 15000]) {
      main.scrollTop = top;
      main.dispatchEvent(new Event('scroll'));
    }
  });
  expect(onRender).toHaveBeenCalledTimes(1);
  const rows = [...document.querySelectorAll<HTMLElement>('.virtual-poster-row')];
  const rowHeight = Number.parseFloat(rows[0].style.height);
  const targetRow = Math.floor(15000 / rowHeight);
  expect(rows.some((row) => Number(row.dataset.rowIndex) === targetRow)).toBe(true);
  expect(document.querySelectorAll('.poster-card').length).toBeLessThan(100);
});

test('分类切换时首屏未就绪保持隐藏，只等待视口图片，滚动不重新等待', async () => {
  vi.useFakeTimers();
  const Grid = VirtualizedPosterGrid;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isImage = this.tagName === 'IMG';
    const top = isImage && this.getAttribute('alt') === '作品1' ? 1100 : 0;
    return { width: 1000, top, bottom: top + (isImage ? 300 : 900), height: isImage ? 300 : 900 } as DOMRect;
  });
  const { rerender } = render(<main className="app-main"><Grid works={[work(0), work(1)]} columns={4} presentationKey="anime_series:all" /></main>);
  const grid = document.querySelector<HTMLElement>('.virtual-poster-grid')!;
  expect(grid).toHaveAttribute('data-presentation', 'preparing');
  expect(grid).toHaveAttribute('inert');
  const images = screen.getAllByRole('img', { hidden: true }) as HTMLImageElement[];
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(grid).toHaveAttribute('data-presentation', 'preparing');
  images[0].dataset.state = 'ready';
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(grid).toHaveAttribute('data-presentation', 'ready');
  expect(grid).not.toHaveAttribute('inert');
  fireEvent.scroll(document.querySelector('.app-main')!);
  expect(grid).toHaveAttribute('data-presentation', 'ready');
  rerender(<main className="app-main"><Grid works={[work(2)]} columns={4} presentationKey="anime_movie:all" /></main>);
  expect(grid).toHaveAttribute('data-presentation', 'preparing');
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(grid).toHaveAttribute('data-presentation', 'ready');
  expect(grid).not.toHaveAttribute('inert');
});

test('快速切换取消旧分类的等待任务，旧超时不得提前放出新分类', async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, top: 0, bottom: 900 } as DOMRect);
  const { rerender, unmount } = render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} presentationKey="a" /></main>);
  const grid = document.querySelector<HTMLElement>('.virtual-poster-grid')!;
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  rerender(<main className="app-main"><VirtualizedPosterGrid works={[work(1)]} columns={4} presentationKey="b" /></main>);
  await act(async () => { await vi.advanceTimersByTimeAsync(220); });
  expect(grid).toHaveAttribute('data-presentation', 'preparing');
  const image = screen.getByRole('img', { hidden: true });
  image.dataset.state = 'error';
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(grid).toHaveAttribute('data-presentation', 'ready');
  rerender(<main className="app-main"><VirtualizedPosterGrid works={[work(2)]} columns={4} presentationKey="c" /></main>);
  expect(grid).toHaveAttribute('inert');
  unmount();
  expect(grid).not.toHaveAttribute('inert');
  expect(grid).not.toHaveAttribute('aria-busy');
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(grid).not.toHaveAttribute('data-presentation');
});

test('无封面的分类首屏和缓存 ready 状态不额外等待超时', async () => {
  vi.useFakeTimers();
  const { rerender } = render(<main className="app-main"><VirtualizedPosterGrid works={[{ ...work(0), local_poster_path: '' }]} columns={4} presentationKey="missing" /></main>);
  const grid = document.querySelector<HTMLElement>('.virtual-poster-grid')!;
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(grid).toHaveAttribute('data-presentation', 'ready');
  rerender(<main className="app-main"><VirtualizedPosterGrid works={[work(1)]} columns={4} presentationKey="cached" /></main>);
  screen.getByRole('img', { hidden: true }).dataset.state = 'ready';
  await act(async () => { await vi.advanceTimersByTimeAsync(40); });
  expect(grid).toHaveAttribute('data-presentation', 'ready');
});

test('尚无尺寸时只显示标题壳，恢复尺寸后仍等待进入观察范围', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 0 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 0 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 0, top: 0 } as DOMRect);
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  expect(screen.queryByRole('img')).toBeNull();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1000 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1000 });
  fireEvent.resize(window);
  await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
  expect(screen.getByRole('img')).not.toHaveAttribute('src');
  expect(api.post).not.toHaveBeenCalled();
});


test('已发布尺寸图直接加载，可见优先且没有前台 prepare 请求', () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={Array.from({ length: 8 }, (_, i) => work(i))} columns={4} /></main>);
  const images = screen.getAllByRole('img') as HTMLImageElement[];
  expect(images.every((node) => !node.hasAttribute('src'))).toBe(true);
  intersect(images, true);
  expect(images.filter((node) => node.hasAttribute('src'))).toHaveLength(6);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.load(images[0]);
  expect(images[6]).toHaveAttribute('src', expect.stringContaining('/api/assets/artwork/'));
  images.forEach((node) => fireEvent.load(node));
});

test('图片加载完成直接显示，不显式 decode，也不触发 React 整网格更新', () => {
  const decode = vi.fn(); Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  const onRender = vi.fn();
  render(<main className="app-main"><Profiler id="grid" onRender={onRender}><VirtualizedPosterGrid works={[work(0)]} columns={4} /></Profiler></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true); onRender.mockClear();
  fireEvent.load(image);
  expect(image).toHaveAttribute('data-state', 'ready');
  expect(decode).not.toHaveBeenCalled();
  expect(onRender).not.toHaveBeenCalled();
});

test('离开预取区不立即清 src，离开驻留区后才清除', () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true); fireEvent.load(image);
  intersect([image], false);
  expect(image).toHaveAttribute('src');
  intersect([image], false, 2);
  expect(image).not.toHaveAttribute('src');
  intersect([image], true); fireEvent.load(image);
});

test('图片版本变化更新同一卡片，旧请求终态不能将新版本标为完成', async () => {
  vi.useFakeTimers();
  const first = work(0);
  const { rerender } = render(<main className="app-main"><VirtualizedPosterGrid works={[first]} columns={4} /></main>);
  const card = screen.getByRole('button');
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  const updatedPath = artworkPath('c', '2');
  rerender(<main className="app-main"><VirtualizedPosterGrid works={[{ ...first, local_poster_path: updatedPath }]} columns={4} /></main>);
  expect(screen.getByRole('button')).toBe(card);
  intersect([image], true);
  fireEvent.load(image);
  expect(image).not.toHaveAttribute('src');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(image).toHaveAttribute('data-state', 'loading');
  expect(image).toHaveAttribute('src', expect.stringContaining(updatedPath));
  fireEvent.load(image);
  expect(image).toHaveAttribute('data-state', 'ready');
});

test('StrictMode 重放与卸载清理观察器，实际撤销已开始请求后释放预算', async () => {
  vi.useFakeTimers();
  const { unmount } = render(<main className="app-main"><StrictMode><VirtualizedPosterGrid works={[work(0)]} columns={4} /></StrictMode></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  expect(image).toHaveAttribute('src');
  unmount();
  expect(disconnect).toHaveBeenCalled();
  expect(document.querySelector('.poster-card')).toBeNull();
  expect(image).not.toHaveAttribute('src');
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
});
