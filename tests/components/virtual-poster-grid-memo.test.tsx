import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import VirtualizedPosterGrid from '../../src/components/library/VirtualizedPosterGrid';
import { api } from '../../src/api/client';

vi.mock('../../src/api/client', () => ({ API_BASE: '', api: { post: vi.fn() } }));
let callback: IntersectionObserverCallback;
let observer: IntersectionObserver;
const observe = vi.fn();
const disconnect = vi.fn();
const work = (index: number) => ({
  work_id: `w${index}`, title: `作品${index}`, source: 'local',
  show_type: 'anime_series', local_poster_path: `D:/mirror/${index}/poster.jpg`, rating: 8,
});
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
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
    constructor(cb: IntersectionObserverCallback) { callback = cb; observer = this as unknown as IntersectionObserver; }
  });
});

function intersect(images: HTMLImageElement[], visible: boolean) {
  act(() => callback(images.map((target) => ({ target, isIntersecting: visible } as unknown as IntersectionObserverEntry)), observer));
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

test('只为观察器范围内的图片查询准备状态，离开范围移除 src', async () => {
  render(<main className="app-main"><VirtualizedPosterGrid works={Array.from({ length: 4 }, (_, i) => work(i))} columns={4} /></main>);
  const images = screen.getAllByRole('img') as HTMLImageElement[];
  expect(images).toHaveLength(4);
  expect(images.every((image) => !image.hasAttribute('src'))).toBe(true);
  intersect(images.slice(0, 4), true);
  await waitFor(() => expect(images[0]).toHaveAttribute('src', expect.stringContaining('cache_only=true')));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls[0][1]).toEqual({ items: images.slice(0, 4).map((_, i) => ({ path: `D:/mirror/${i}/poster.jpg`, width: 256 })) });
  expect(images.filter((image) => image.hasAttribute('src'))).toHaveLength(4);
  intersect(images.slice(0, 4), false);
  expect(images.every((image) => !image.hasAttribute('src'))).toBe(true);
  expect(screen.getAllByRole('button')).toHaveLength(4);
  intersect(images.slice(0, 4), true);
  expect(images[0]).toHaveAttribute('src');
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('分类图片等待异步解码后显示，加载完成不提交 React 更新', async () => {
  let finish!: () => void;
  const decode = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  const onRender = vi.fn();
  render(<main className="app-main"><Profiler id="grid" onRender={onRender}><VirtualizedPosterGrid works={[work(0)]} columns={4} /></Profiler></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(image).toHaveAttribute('src'));
  onRender.mockClear();
  fireEvent.load(image);
  expect(image).toHaveAttribute('decoding', 'async');
  expect(image).toHaveAttribute('data-state', 'loading');
  expect(decode).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
  expect(image).toHaveAttribute('data-state', 'ready');
  expect(onRender).not.toHaveBeenCalled();
});

test('图片离开范围后旧解码返回，不能恢复 ready 或污染再次加载的状态', async () => {
  const finishes: Array<() => void> = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true,
    value: vi.fn(() => new Promise<void>(resolve => finishes.push(resolve))) });
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(image).toHaveAttribute('src'));
  fireEvent.load(image);
  intersect([image], false);
  intersect([image], true);
  fireEvent.load(image);
  expect(finishes).toHaveLength(2);
  await act(async () => { finishes[0](); });
  expect(image).toHaveAttribute('data-state', 'loading');
  await act(async () => { finishes[1](); });
  expect(image).toHaveAttribute('data-state', 'ready');
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

test('load 与缓存 complete 同时到达只解码一次，错误会使待完成解码失效', async () => {
  let finish!: () => void;
  const decode = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(256);
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(image).toHaveAttribute('src'));
  fireEvent.load(image);
  expect(decode).toHaveBeenCalledTimes(1);
  fireEvent.error(image);
  await act(async () => { finish(); });
  expect(image).toHaveAttribute('data-state', 'error');
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

test('StrictMode 重挂载和卸载后清理观察器及批量请求', async () => {
  const { unmount } = render(<main className="app-main"><StrictMode><VirtualizedPosterGrid works={[work(0)]} columns={4} /></StrictMode></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(image).toHaveAttribute('src'));
  unmount();
  expect(disconnect).toHaveBeenCalled();
  expect(document.querySelector('.poster-card')).toBeNull();
});

test('后台临时失败后延迟重试，成功后显示缩略图', async () => {
  vi.useFakeTimers();
  vi.mocked(api.post).mockResolvedValueOnce({ states: ['retry'] }).mockResolvedValueOnce({ states: ['ready'] });
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(image).toHaveAttribute('data-state', 'retry');
  expect(image).not.toHaveAttribute('src');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(image).toHaveAttribute('src');
  expect(api.post).toHaveBeenCalledTimes(2);
});

test('图片离开范围后异步就绪不会恢复远处 src，返回时立即复用', async () => {
  let finish!: (value: { states: string[] }) => void;
  vi.mocked(api.post).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<main className="app-main"><VirtualizedPosterGrid works={[work(0)]} columns={4} /></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  intersect([image], false);
  await act(async () => { finish({ states: ['ready'] }); });
  expect(image).not.toHaveAttribute('src');
  intersect([image], true);
  expect(image).toHaveAttribute('src');
  expect(api.post).toHaveBeenCalledTimes(1);
});
