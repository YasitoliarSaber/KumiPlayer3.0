import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import DecodedImage from '../../src/components/ui/DecodedImage';
import { defaultImageLifecycle } from '../../src/components/library/posterImageLifecycle';

afterEach(() => {
  defaultImageLifecycle.dispose();
  vi.unstubAllGlobals();
});

function observeRootContainment() {
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
  return () => act(() => {
    for (const observer of observers) {
      const changes = [...observer.targets].map(target => ({
        target,
        // 浏览器的显式 root 只能与其后代相交，侧栏不属于 main 的滚动范围。
        isIntersecting: observer.root === null || observer.root.contains(target),
      } as IntersectionObserverEntry));
      observer.notify(changes, {} as IntersectionObserver);
    }
  });
}

function Shell({ page }: { page: number }) {
  return <>
    <aside><DecodedImage src="/api/integrations/bangumi/avatar?url=fixture" alt="侧栏头像" /></aside>
    <main className="app-main">
      {page > 0 && <DecodedImage src={`/page/${page}`} alt="页面图片" />}
    </main>
  </>;
}

test.each([true, false])('页面图片挂载与切换不能清除侧栏头像，侧栏先完成加载=%s', (loadedBeforePage) => {
  const notify = observeRootContainment();
  const { rerender } = render(<Shell page={0} />);
  notify();
  const avatar = screen.getByRole('img', { name: '侧栏头像' });
  expect(avatar).toHaveAttribute('src', '/api/integrations/bangumi/avatar?url=fixture');
  if (loadedBeforePage) fireEvent.load(avatar);

  rerender(<Shell page={1} />);
  notify();
  if (!loadedBeforePage) fireEvent.load(avatar);
  expect(avatar).toHaveAttribute('src', '/api/integrations/bangumi/avatar?url=fixture');
  expect(avatar).toHaveAttribute('data-image-state', 'ready');
  fireEvent.load(screen.getByRole('img', { name: '页面图片' }));

  rerender(<Shell page={2} />);
  notify();
  fireEvent.load(screen.getByRole('img', { name: '页面图片' }));
  expect(screen.getByRole('img', { name: '侧栏头像' })).toBe(avatar);
  expect(avatar).toHaveAttribute('src', '/api/integrations/bangumi/avatar?url=fixture');
  expect(avatar).toHaveAttribute('data-image-state', 'ready');
});
