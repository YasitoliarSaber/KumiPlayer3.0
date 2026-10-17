import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { PosterCard } from '../../src/renderer/shared/ui/PosterCard';
import { resolveColumns } from '../../src/renderer/shared/ui/PosterGrid';

const work = buildMockCatalog().works.find((entry) => entry.progress && entry.artwork.fanart)!;

describe('海报展示契约', () => {
  it('海报图片不叠加观看进度，已看完也保持纯图片', () => {
    const completed = { ...work, progress: { ...work.progress!, completed: true, position: 0 } };
    render(<PosterCard work={completed} onOpen={vi.fn()} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('播放中的作品同样不在海报上叠加速度或进度', () => {
    render(<PosterCard work={work} onOpen={vi.fn()} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  });

  it('背景图偏好保留媒体库说明，不变成继续观看卡片', () => {
    render(<PosterCard work={work} onOpen={vi.fn()} imageMode="fanart" />);
    expect(screen.getByRole('img')).toHaveAttribute('src', work.artwork.fanart!.url);
    expect(screen.queryByText(/还剩/)).toBeNull();
    // 原型已把海报卡副标题收敛为季数；年份不再出现在卡片上。
    expect(screen.getByText(new RegExp(`共 ${work.seasonCount} 季`))).toBeTruthy();
  });

  it('分类模式只显示作品名，不显示季数等副标题', () => {
    render(<PosterCard work={work} onOpen={vi.fn()} showSubtitle={false} />);
    expect(screen.getByText(work.title)).toBeTruthy();
    expect(screen.queryByText(new RegExp(`共 ${work.seasonCount} 季`))).toBeNull();
    expect(screen.queryByText(/还剩/)).toBeNull();
  });

  it('继续观看模式保留进度文字与图片下方进度条', () => {
    const inProgress = { ...work, progress: { ...work.progress!, completed: false, position: 600, duration: 1200 } };
    render(<PosterCard work={inProgress} variant="wide" onOpen={vi.fn()} />);
    expect(screen.getByText(new RegExp(`${inProgress.progress.episodeCode}.*还剩`))).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: `${work.title}观看进度` })).toHaveAttribute('aria-valuenow', '50');
  });

  it('无效、过大与小数列数不能破坏虚拟网格', () => {
    expect(resolveColumns(2000, Number.NaN)).toBe(8);
    expect(resolveColumns(2000, 100)).toBe(9);
    expect(resolveColumns(2000, 3.8)).toBe(6);
    expect(resolveColumns(280, -1)).toBe(2);
  });

  it('桌面容器落实选定密度，小窗口自动降列且不横向溢出', () => {
    expect(resolveColumns(976, 8)).toBe(8);
    expect(resolveColumns(976, 9)).toBe(9);
    expect(resolveColumns(400, 8)).toBe(3);
  });
});
