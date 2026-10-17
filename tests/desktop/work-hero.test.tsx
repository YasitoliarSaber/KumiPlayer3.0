import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkHero } from '../../src/renderer/features/work/WorkHero';
import { buildMockCatalog, buildMockDetail } from '../../src/renderer/mock/catalog';

const catalog = buildMockCatalog();
const work = buildMockDetail(catalog.works[0]!, catalog);
const resume = work.seasons[0]!.episodes[0]!;

function showHero(overrides: Partial<Parameters<typeof WorkHero>[0]> = {}) {
  return render(<WorkHero work={work} resume={resume} resumePosition={60} resumeDuration={150} resumePercent={40}
    busy={false} favoriteBusy={false} preferredSource="" notice="" onBack={vi.fn()}
    onSourceChange={vi.fn()} onPlay={vi.fn()} onFavorite={vi.fn()} {...overrides}>
    <button>更多操作</button>
  </WorkHero>);
}

describe('旧版结构的作品概要', () => {
  it('简介可展开、收起；阅读长简介不会触发播放', () => {
    const onPlay = vi.fn();
    showHero({ onPlay });
    const plot = screen.getByRole('button', { name: '展开完整作品简介' });
    expect(plot).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(plot);
    expect(screen.getByRole('button', { name: '收起作品简介' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(plot);
    expect(plot).toHaveAttribute('aria-expanded', 'false');
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('继续观看在同一按钮中包含目标、进度和真实播放回调', () => {
    const onPlay = vi.fn();
    showHero({ onPlay });
    const button = screen.getByRole('button', { name: /继续观看/ });
    expect(button).toHaveTextContent(resume.title);
    expect(button).toHaveTextContent(resume.code);
    expect(within(button).getByRole('progressbar', { name: '观看进度' })).toHaveAttribute('aria-valuenow', '40');
    fireEvent.click(button);
    expect(onPlay).toHaveBeenCalledOnce();
  });

  it('标题图失败后恢复文字标题，单一来源不制造无用菜单或额外海报', () => {
    const view = showHero({ work: {
      ...work, sources: ['local'],
      artwork: { ...work.artwork, clearlogo: { url: '/title-logo.png', width: 512, height: 160 } },
    } });
    const heading = screen.getByRole('heading', { name: work.title });
    const logo = heading.querySelector('img')!;
    expect(logo).toBeTruthy();
    fireEvent.error(logo);
    expect(heading.querySelector('img')).toBeNull();
    expect(heading).toHaveTextContent(work.title);
    expect(view.container.querySelector(`img[src="${work.artwork.poster?.url}"]`)).toBeNull();
    expect(screen.queryByRole('button', { name: /本地目录/ })).toBeNull();
  });

  it('悬停层与无障碍名称包含百分比、剩余时间和总长，不额外查询播放器', () => {
    const view = showHero({ resumePosition: 360, resumeDuration: 1500, resumePercent: 24 });
    const button = screen.getByRole('button', { name: /继续观看.*24%.*剩余 19:00.*总长 25:00/ });
    expect(button).toHaveTextContent('24%');
    expect(button).toHaveTextContent('剩余 19:00 · 总长 25:00');
    expect(view.container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('未知时长不编造百分比，超出时长时剩余时间不为负', () => {
    const view = showHero({ resumeDuration: 0, resumePercent: 0 });
    expect(screen.getByRole('button', { name: /进度待获取.*时长待获取/ })).toBeTruthy();
    view.unmount();
    showHero({ resumePosition: 4000, resumeDuration: 3600, resumePercent: 100 });
    expect(screen.getByRole('button', { name: /剩余 00:00.*总长 1:00:00/ })).toBeTruthy();
  });
});
