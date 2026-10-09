import { fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import VirtualizedPosterGrid from '../../src/components/library/VirtualizedPosterGrid';

const artwork = (seed: 'a' | 'b') => `/api/assets/artwork/${seed.repeat(64)}/${seed.repeat(64)}-webp-v1/384`;
const work = (id: string) => ({
  work_id: id,
  title: id,
  source: 'local',
  media_type: 'tv',
  show_type: 'anime_series',
  local_poster_path: artwork(id === 'added' ? 'b' : 'a'),
  rating: 8,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('appending a work keeps a retained poster registered and able to reach ready', () => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 960 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 960 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 800 });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 960, top: 0 } as DOMRect);

  const { rerender } = render(<main className="app-main">
    <VirtualizedPosterGrid works={[work('retained')]} columns={4} />
  </main>);
  const image = document.querySelector<HTMLImageElement>('.poster-managed-image')!;
  expect(image).toHaveAttribute('data-state', 'loading');

  rerender(<main className="app-main">
    <VirtualizedPosterGrid works={[work('retained'), work('added')]} columns={4} />
  </main>);
  fireEvent.load(image);

  // 增量添加卡片时，已有图片的登记必须继续接收加载完成事件。
  expect(image).toHaveAttribute('data-state', 'ready');
});
