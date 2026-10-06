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

test('分类图片由浏览器异步解码，加载完成不提交 React 更新', async () => {
  const decode = vi.fn();
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: decode });
  const onRender = vi.fn();
  render(<main className="app-main"><Profiler id="grid" onRender={onRender}><VirtualizedPosterGrid works={[work(0)]} columns={4} /></Profiler></main>);
  const image = screen.getByRole('img') as HTMLImageElement;
  intersect([image], true);
  await waitFor(() => expect(image).toHaveAttribute('src'));
  onRender.mockClear();
  fireEvent.load(image);
  expect(image).toHaveAttribute('decoding', 'async');
  expect(image).toHaveAttribute('data-state', 'ready');
  expect(decode).not.toHaveBeenCalled();
  expect(onRender).not.toHaveBeenCalled();
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
