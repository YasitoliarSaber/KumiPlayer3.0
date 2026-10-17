import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { PosterCard } from '../../src/renderer/shared/ui/PosterCard';
import { resolveColumns } from '../../src/renderer/shared/ui/PosterGrid';

const work = buildMockCatalog().works.find((entry) => entry.progress && entry.artwork.fanart)!;

describe('海报展示契约', () => {
  it('已看完优先于旧位置，进度条显示完整状态', () => {
    const completed = { ...work, progress: { ...work.progress!, completed: true, position: 0 } };
    render(<PosterCard work={completed} onOpen={vi.fn()} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('背景图偏好保留媒体库说明，不变成继续观看卡片', () => {
    render(<PosterCard work={work} onOpen={vi.fn()} imageMode="fanart" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', work.artwork.fanart!.url);
    expect(screen.queryByText(/还剩/)).toBeNull();
    // 原型已把海报卡副标题收敛为季数；年份不再出现在卡片上。
    expect(screen.getByText(new RegExp(`共 ${work.seasonCount} 季`))).toBeTruthy();
  });

  it('无效、过大与小数列数不能破坏虚拟网格', () => {
    expect(resolveColumns(2000, Number.NaN)).toBe(8);
    expect(resolveColumns(2000, 100)).toBe(10);
    expect(resolveColumns(2000, 3.8)).toBe(3);
    expect(resolveColumns(400, -1)).toBe(2);
  });
});
