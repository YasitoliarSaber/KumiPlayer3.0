import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import DecodedImage from '../../src/components/ui/DecodedImage';
import { defaultImageLifecycle } from '../../src/components/library/posterImageLifecycle';

afterEach(() => {
  defaultImageLifecycle.dispose();
  vi.unstubAllGlobals();
});

test('固定的全页背景按视口观察，不会被内容滚动根判成不可见', () => {
  const observers: { root: Element | Document | null; targets: Set<Element>; notify: IntersectionObserverCallback }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    private record;
    constructor(notify: IntersectionObserverCallback, options: IntersectionObserverInit) {
      this.record = { root: options.root ?? null, targets: new Set<Element>(), notify };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.targets.add(target); }
    unobserve(target: Element) { this.record.targets.delete(target); }
    disconnect() { this.record.targets.clear(); }
  });
  const { container, unmount } = render(<main className="app-main">
    <div className="detail-hero" style={{ position: 'fixed' }}>
      <DecodedImage src="/api/assets/artwork/fixed/v1/1280" alt="" className="detail-hero-art" visibilityRoot="viewport" />
    </div>
  </main>);
  const image = container.querySelector('img')!;
  const notify = () => act(() => {
    for (const observer of observers) {
      observer.notify([...observer.targets].map(target => ({
        target,
        // fixed 背景的 containing-block 链越过 main；真实 Chromium 同样返回不相交。
        isIntersecting: observer.root === null,
      } as IntersectionObserverEntry)), {} as IntersectionObserver);
    }
  });
  notify();
  expect(image).toHaveAttribute('src', '/api/assets/artwork/fixed/v1/1280');
  fireEvent.load(image);
  notify();
  expect(image).toHaveAttribute('data-image-state', 'ready');
  expect(image).toHaveAttribute('src', '/api/assets/artwork/fixed/v1/1280');
  expect(image).not.toHaveAttribute('visibilityRoot');
  unmount();
});
