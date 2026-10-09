import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import AppShell from '../../src/components/shell/AppShell';
import { ArtworkLoadBudget, PosterImageLifecycle } from '../../src/components/library/posterImageLifecycle';
import { api } from '../../src/api/client';
import { clearScrollDiagnostics, disableScrollDiagnostics, dumpScrollDiagnostics, enableScrollDiagnostics } from '../../src/utils/scrollDiagnostics';

vi.mock('../../src/components/shell/Sidebar', () => ({ default: () => null }));
vi.mock('../../src/components/shell/DesktopTitleBar', () => ({ default: () => null }));
vi.mock('../../src/api/client', () => ({ API_BASE: '', api: { post: vi.fn() } }));

let intersect: IntersectionObserverCallback;
const intersections: IntersectionObserverCallback[] = [];
const disconnect = vi.fn();
beforeEach(() => {
  disableScrollDiagnostics({ persist: false });
  clearScrollDiagnostics();
  vi.clearAllMocks();
  intersections.length = 0;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; intersections.push(callback); }
    observe() {}
    unobserve() {}
    disconnect = disconnect;
  });
});
afterEach(() => {
  disableScrollDiagnostics({ persist: false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('页面挂载后开启采样立即记录输入，wheel 不吞掉同帧 scroll，关闭后停止', () => {
  render(<AppShell><div>作品墙</div></AppShell>);
  const main = document.querySelector<HTMLElement>('main.app-main')!;
  enableScrollDiagnostics({ persist: false });
  main.scrollTop = 500;
  fireEvent.wheel(main, { deltaY: 500 });
  fireEvent.scroll(main);
  expect(dumpScrollDiagnostics().counts).toMatchObject({ wheel: 1, scroll: 1 });
  disableScrollDiagnostics({ persist: false });
  fireEvent.wheel(main, { deltaY: 500 });
  fireEvent.scroll(main);
  expect(dumpScrollDiagnostics().counts).toMatchObject({ wheel: 1, scroll: 1 });
  enableScrollDiagnostics({ persist: false });
  fireEvent.scroll(main);
  expect(dumpScrollDiagnostics().counts.scroll).toBe(1);
});

test('已发布资源只写实际 src，可见前不请求准备，完成和注销记录实际变更', () => {
  enableScrollDiagnostics({ persist: false });
  const lifecycle = new PosterImageLifecycle(new ArtworkLoadBudget());
  lifecycle.configure(null, 900);
  const image = document.createElement('img');
  const unregister = lifecycle.register(image, { path: 'fixture', width: 256, url: 'fixture-url', local: true });
  expect(image.hasAttribute('src')).toBe(false);
  expect(dumpScrollDiagnostics().counts['image-src-set'] ?? 0).toBe(0);
  intersections[0]([{ target: image, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  expect(api.post).not.toHaveBeenCalled();
  expect(image).toHaveAttribute('src', 'fixture-url');
  expect(dumpScrollDiagnostics().counts['image-src-set']).toBe(1);
  fireEvent.load(image);
  unregister();
  expect(dumpScrollDiagnostics().counts['image-src-cleared']).toBe(1);
  lifecycle.dispose();
});

test('布局尺寸未变化不重建图片观察器，不重放全部图片范围通知', () => {
  const lifecycle = new PosterImageLifecycle();
  const root = document.createElement('main');
  lifecycle.configure(root, 900);
  const callback = intersect;
  lifecycle.configure(root, 900);
  expect(disconnect).not.toHaveBeenCalled();
  expect(intersect).toBe(callback);
  lifecycle.configure(root, 800);
  expect(disconnect).toHaveBeenCalledTimes(3);
  lifecycle.dispose();
});

test('后台隐藏期间不把暂停的动画帧记作前台冻结，清空后重置帧基线', () => {
  let frame!: FrameRequestCallback;
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1; });
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  visibility.mockReturnValue('visible');
  enableScrollDiagnostics({ persist: false });
  now = 1000;
  visibility.mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  frame(now);
  now = 5000;
  visibility.mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  now += 16;
  frame(now);
  expect(dumpScrollDiagnostics().slowFrameCount).toBe(0);
  now += 500;
  clearScrollDiagnostics();
  now += 16;
  frame(now);
  expect(dumpScrollDiagnostics().slowFrameCount).toBe(0);
  now += 150;
  frame(now);
  expect(dumpScrollDiagnostics().worstFrameGapMs).toBe(150);
});
