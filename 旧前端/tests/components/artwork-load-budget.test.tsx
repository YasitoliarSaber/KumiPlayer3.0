import { afterEach, expect, test, vi } from 'vitest';
import { ArtworkLoadBudget, PosterImageLifecycle } from '../../src/components/library/posterImageLifecycle';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const image = () => document.createElement('img');
const loaded = (node: HTMLImageElement) => node.dispatchEvent(new Event('load'));

test('实际 DOM 加载最多六个，预取最多两个，load/error 终态才释放预算', () => {
  const budget = new ArtworkLoadBudget();
  const nodes = Array.from({ length: 10 }, image);
  nodes.forEach((node, index) => budget.enqueue(node, `/image/${index}`, index < 4 ? 0 : 1, () => {}));
  expect(nodes.filter((node) => node.hasAttribute('src'))).toHaveLength(6);
  loaded(nodes[0]);
  expect(nodes[6]).not.toHaveAttribute('src'); // 预取仍占满两项。
  nodes[4].dispatchEvent(new Event('error'));
  expect(nodes[6]).toHaveAttribute('src');
  expect(nodes[7]).not.toHaveAttribute('src');
});

test('排队可见图优先；实际撤销旧请求后释放预算，取消不伪装加载成功', async () => {
  vi.useFakeTimers();
  const budget = new ArtworkLoadBudget(1, 1);
  const [active, prefetch, visible] = [image(), image(), image()];
  const state = vi.fn();
  const first = budget.enqueue(active, '/active', 0, state);
  budget.enqueue(prefetch, '/preload', 1, () => {});
  budget.enqueue(visible, '/visible', 0, () => {});
  first.cancel();
  expect(active).not.toHaveAttribute('src');
  expect(visible).not.toHaveAttribute('src');
  expect(first.pending()).toBe(true);
  loaded(active); // 撤销时已移除监听，晚到终态不放行新任务。
  expect(visible).not.toHaveAttribute('src');
  await vi.advanceTimersByTimeAsync(0);
  expect(first.pending()).toBe(false);
  expect(state).not.toHaveBeenCalledWith('ready');
  expect(visible).toHaveAttribute('src');
  expect(prefetch).not.toHaveAttribute('src');
  loaded(visible);
  expect(prefetch).toHaveAttribute('src');
  loaded(prefetch);
});

test('失败冷却按版本 URL 隔离，不重复请求坏版本，新版本立即可用', async () => {
  vi.useFakeTimers();
  const budget = new ArtworkLoadBudget(2, 1, 1000);
  const old = image(); budget.enqueue(old, '/resource/v1/384', 0, () => {});
  old.dispatchEvent(new Event('error'));
  const retry = image(); budget.enqueue(retry, '/resource/v1/384', 0, () => {});
  const updated = image(); budget.enqueue(updated, '/resource/v2/384', 0, () => {});
  expect(retry).not.toHaveAttribute('src');
  expect(updated).toHaveAttribute('src');
  await vi.advanceTimersByTimeAsync(1000);
  expect(retry).toHaveAttribute('src');
});

test('离开预取区保留驻留图片，离开两视口驻留才清除；排队任务淘汰', () => {
  const callbacks: IntersectionObserverCallback[] = [];
  const options: IntersectionObserverInit[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    observe() {} unobserve() {} disconnect() {}
    constructor(cb: IntersectionObserverCallback, config: IntersectionObserverInit) { callbacks.push(cb); options.push(config); }
  });
  const lifecycle = new PosterImageLifecycle(new ArtworkLoadBudget(1, 1));
  lifecycle.configure(null, 1000);
  expect(options.map((option) => option.rootMargin)).toEqual(['0px', '500px 0px 1000px 0px', '2000px 0px']);
  const [a, b] = [image(), image()];
  lifecycle.register(a, { url: '/a' }); lifecycle.register(b, { url: '/b' });
  const enter = (index: number, node: HTMLImageElement, isIntersecting: boolean) => callbacks[index]([{ target: node, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  enter(0, a, true); enter(1, b, true);
  enter(1, b, false);
  loaded(a);
  expect(b).not.toHaveAttribute('src');
  enter(0, a, false);
  expect(a).toHaveAttribute('src');
  enter(2, a, false);
  expect(a).not.toHaveAttribute('src');
  lifecycle.dispose();
});

test('旧请求终态不能标记已替换地址的新记录就绪', async () => {
  vi.useFakeTimers();
  const lifecycle = new PosterImageLifecycle(new ArtworkLoadBudget(1, 1));
  const node = image();
  const oldState = vi.fn(); const newState = vi.fn();
  const remove = lifecycle.register(node, { url: '/old', onState: oldState });
  remove();
  lifecycle.register(node, { url: '/new', onState: newState });
  loaded(node);
  expect(oldState).not.toHaveBeenCalledWith('ready');
  expect(newState).not.toHaveBeenCalledWith('ready');
  expect(node).not.toHaveAttribute('src');
  await vi.advanceTimersByTimeAsync(0);
  expect(node).toHaveAttribute('src', '/new');
  loaded(node);
  expect(newState).toHaveBeenCalledWith('ready');
  lifecycle.dispose();
});

test('持续可见的失败图片有限重试，卸载取消冷却重排', async () => {
  vi.useFakeTimers();
  const lifecycle = new PosterImageLifecycle(new ArtworkLoadBudget(1, 1, 30_000));
  const node = image();
  const state = vi.fn();
  const remove = lifecycle.register(node, { url: '/transient', onState: state });
  node.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.mock.calls.filter(([value]) => value === 'loading')).toHaveLength(2);
  node.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(state.mock.calls.filter(([value]) => value === 'loading')).toHaveLength(3);
  node.dispatchEvent(new Event('error'));
  await vi.advanceTimersByTimeAsync(90_000);
  expect(state.mock.calls.filter(([value]) => value === 'loading')).toHaveLength(3);
  remove(); lifecycle.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
