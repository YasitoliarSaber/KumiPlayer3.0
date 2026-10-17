import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildMockCatalog, buildMockDetail } from '../../src/renderer/mock/catalog';
import { createMockMediaService } from '../../src/renderer/mock/service';
import { ServiceProvider, demoQueryKeys } from '../../src/renderer/shared/api/service-context';
import { WorkSuggestions } from '../../src/renderer/features/work/WorkSuggestions';
import { selectRecommendations } from '../../src/renderer/features/work/recommendations';
import { EpisodeStrip } from '../../src/renderer/features/work/EpisodeStrip';

const catalog = buildMockCatalog();
const work = { ...buildMockDetail(catalog.works[0]!, catalog), related: [] };

describe('详情推荐与简洁分集', () => {
  it('分集只有可点击图片和标题，没有中央图标或翻页按钮', () => {
    const episodes = work.seasons[0]!.episodes.slice(0, 3);
    const onPlay = vi.fn();
    const view = render(<EpisodeStrip episodes={episodes} seasonId="s1" label="第 1 季" onPlay={onPlay} />);
    expect(view.container.querySelector('svg')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: '下一组剧集' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button')[0]!);
    expect(onPlay).toHaveBeenCalledWith(episodes[0]);
  });

  it('推荐排除自己、已关联、重复及无图作品，最多六部', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => ({ ...work, id: `candidate-${i}` }));
    const current = { ...work, related: [candidates[0]!] };
    const result = selectRecommendations(current, [current, ...candidates, candidates[1]!, { ...work, id: 'no-poster', artwork: { ...work.artwork, poster: null } }]);
    expect(result).toHaveLength(6);
    expect(new Set(result.map((item) => item.id)).size).toBe(6);
    expect(result.map((item) => item.id)).not.toContain(current.id);
    expect(result.map((item) => item.id)).not.toContain('candidate-0');
    expect(result.map((item) => item.id)).not.toContain('no-poster');
  });

  it('共同题材优先，同分时高评分优先；完全无关的不推荐', () => {
    const current = { ...work, genres: ['校园'], tags: [] };
    const candidate = { ...work, genres: [], tags: [] };
    const result = selectRecommendations(current, [
      { ...candidate, id: 'type-only', rating: 10 },
      { ...candidate, id: 'shared-low', genres: ['校园'], rating: 7 },
      { ...candidate, id: 'shared-high', genres: ['校园'], rating: 9 },
      { ...candidate, id: 'unrelated', showType: 'live_movie' },
    ]);
    expect(result.map((item) => item.id)).toEqual(['shared-high', 'shared-low', 'type-only']);
  });

  it('推荐卡片共用已有媒体库缓存，点击打开对应详情', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const candidate = { ...work, id: 'recommendation', title: '同题材作品' };
    const snapshot = { works: [work, candidate], sources: [], ongoingCategoryName: '新番' };
    client.setQueryData(demoQueryKeys.library, snapshot);
    const listLibrary = vi.fn(async () => snapshot);
    const onOpen = vi.fn();
    render(<QueryClientProvider client={client}><ServiceProvider service={{ ...createMockMediaService({ catalog, latencyMs: 0 }), listLibrary }}>
      <WorkSuggestions work={work} onOpen={onOpen} />
    </ServiceProvider></QueryClientProvider>);
    const shelf = screen.getByRole('region', { name: '相关推荐' });
    fireEvent.click(within(shelf).getByRole('button', { name: '打开同题材作品详情' }));
    expect(onOpen).toHaveBeenCalledWith('recommendation');
    expect(listLibrary).not.toHaveBeenCalled();
    client.clear();
  });
});
