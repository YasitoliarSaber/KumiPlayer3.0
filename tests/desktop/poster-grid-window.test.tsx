import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMockCatalog } from '@/mock/catalog';
import type { WorkSummary } from '@/shared/api/service';
import { PosterGrid } from '@/shared/ui/PosterGrid';
import { artworkLifecycle } from '@/shared/ui/artwork-lifecycle';

const works = buildMockCatalog().works.slice(0, 1000);
function Grid({ items = works, imageMode = 'poster' }: { items?: readonly WorkSummary[]; imageMode?: 'poster' | 'fanart' }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return <div ref={scrollRef} data-testid="scroll"><PosterGrid scrollRef={scrollRef} works={items} onOpen={() => undefined} imageMode={imageMode} /></div>;
}

beforeEach(() => {
  for (const property of ['offsetWidth', 'clientWidth']) vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(1000);
  for (const property of ['offsetHeight', 'clientHeight']) vi.spyOn(HTMLElement.prototype, property, 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000, height: 600, top: 0, left: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => artworkLifecycle.dispose());

describe('真实 TanStack 虚拟窗口', () => {
  it('千部作品只挂载视口和邻近行，深层位置优先于逻辑首行，焦点行保持挂载', async () => {
    const view = render(<Grid />);
    const scroll = screen.getByTestId('scroll');
    const first = view.container.querySelector<HTMLButtonElement>('[data-work-id]')!;
    expect(first).toBeTruthy();
    act(() => first.focus());
    fireEvent.scroll(scroll, { target: { scrollTop: 5000 } });
    await waitFor(() => expect(view.container.querySelectorAll('[data-work-id]').length).toBeGreaterThan(8));
    expect(view.container.querySelectorAll('[data-work-id]').length).toBeLessThan(80);
    expect(first).toBeInTheDocument();
    expect(document.activeElement).toBe(first);
    expect(first.querySelector('img')).toHaveAttribute('data-artwork-priority', 'resident');
    expect(view.container.querySelectorAll('[data-artwork-priority="visible"]').length).toBeGreaterThan(0);
    expect(view.container.querySelector('[data-poster-total]')).toHaveAttribute('data-poster-total', String(works.length));
  });

  it('空分类转为有内容可重新测量，切换图片模式重新计算总高度', () => {
    const view = render(<Grid items={[]} />);
    expect(screen.getByText('这个筛选下还没有作品')).toBeTruthy();
    view.rerender(<Grid />);
    const grid = view.container.querySelector<HTMLElement>('[data-virtual-rows]')!;
    expect(Number(grid.dataset.virtualRows)).toBeGreaterThan(0);
    const posterHeight = (grid.firstElementChild as HTMLElement).style.height;
    view.rerender(<Grid imageMode="fanart" />);
    expect((grid.firstElementChild as HTMLElement).style.height).not.toBe(posterHeight);
    expect(view.container.querySelectorAll('[data-work-id]').length).toBeLessThan(100);
  });
});
