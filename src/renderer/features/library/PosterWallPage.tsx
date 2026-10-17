/**
 * 海报墙页面（媒体库分类 / 收藏 / 搜索共用）。
 *
 * 复刻当前应用分类页结构：标题 + 数量 + 排序菜单 + 虚拟化海报墙；
 * 排序条件放在 URL 上，返回时由路由自然恢复；滚动位置按视图与筛选单独记录。
 */

import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import type { SortId, WorkSummary } from '../../shared/api/service';
import { useLibrary, useMediaService } from '../../shared/api/service-context';
import { useQuery } from '@tanstack/react-query';
import { PosterGrid } from '../../shared/ui/PosterGrid';
import { EmptySurface, ErrorSurface, LoadingSurface } from '../../shared/ui/Surface';
import { useMainScroll } from '../../shell/AppShell';
import { useUiStore } from '../../app/ui-store';
import { pushDemoPreference } from '../../mock/preferences';
import { matchView } from '../../shell/AppShell';
import { Button } from '@/shared/ui/button';
import { Slider } from '@/shared/ui/slider';
import { useDemoState } from '@/mock/demo-store';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import styles from './PosterWallPage.module.css';

const SORT_OPTIONS: ReadonlyArray<{ id: SortId; label: string }> = [
  { id: 'recent', label: '最近观看' },
  { id: 'title', label: '标题' },
  { id: 'year', label: '年份' },
  { id: 'rating', label: '评分' },
  { id: 'episodesDesc', label: '集数' },
];

const VIEW_TITLES: Record<string, string> = {
  seasonal: '新番',
  anime_series: '番剧',
  anime_movie: '动画电影',
  live_series: '剧集',
  live_movie: '电影',
};

type WallMode =
  | { readonly kind: 'view'; readonly view?: string }
  | { readonly kind: 'favorites' }
  | { readonly kind: 'search' };

const scrollPositions = new Map<string, number>();

export function PosterWallPage({ mode }: { readonly mode: WallMode }) {
  const library = useLibrary();
  const service = useMediaService();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const source = useUiStore((state) => state.source);
  const setSource = useUiStore((state) => state.setSource);
  const { posterSize, cardImageMode } = useDemoState().settings.appearance;
  const posterColumns = useUiStore((state) => state.posterColumns);
  const setPosterColumns = useUiStore((state) => state.setPosterColumns);
  const mainScroll = useMainScroll();
  const view = mode.kind === 'view' ? params.view ?? 'anime_series' : mode.kind;
  const query = mode.kind === 'search' ? (searchParams.get('q') ?? '').trim() : '';
  // 默认按最近观看排序：演示库中同一基作有几十个条目，按标题排序会把首屏压成同名卡片。
  const sort = (searchParams.get('sort') as SortId | null) ?? 'recent';
  const scrollKey = `${String(view)}|${source}|${sort}|${query}`;

  const remoteSearch = useQuery({
    queryKey: ['library-search', query, source],
    enabled: mode.kind === 'search' && query.length > 0 && typeof service.searchLibrary === 'function',
    queryFn: () => service.searchLibrary!(query, 100),
  });

  const works = useMemo(() => {
    const all = library.data?.works ?? [];
    // 真实后端提供轻量搜索索引（标题/原名/别名/标签/制作公司）时按命中集合过滤；
    // 没有该能力时用本地索引做同一组字段的匹配，结果口径一致。
    const remoteIds =
      mode.kind === 'search' && query.length > 0 && remoteSearch.data
        ? new Set(remoteSearch.data.hits.map((hit) => hit.workId))
        : null;
    return all
      .filter((work) => source === 'all' || work.sources.includes(source))
      .filter((work) => (mode.kind === 'favorites' ? work.watch.favorite : true))
      .filter((work) => (mode.kind === 'view' ? matchView(work, view as never) : true))
      .filter((work) =>
        query.length > 0
          ? remoteIds
            ? remoteIds.has(work.id)
            : matchesQuery(work, query)
          : true,
      );
  }, [library.data?.works, mode.kind, query, remoteSearch.data, source, view]);

  const sorted = useMemo(() => sortWorks(works, sort), [works, sort]);

  // 返回该视图时恢复上次滚动位置；只在同一滚动容器上做一次恢复。
  useLayoutEffect(() => {
    const element = mainScroll.current;
    const saved = scrollPositions.get(scrollKey) ?? 0;
    const frame = requestAnimationFrame(() => {
      element?.scrollTo({ top: saved, behavior: 'auto' });
    });
    return () => cancelAnimationFrame(frame);
  }, [mainScroll, scrollKey]);

  useEffect(() => {
    const element = mainScroll.current;
    if (!element) {
      return undefined;
    }
    return () => {
      scrollPositions.set(scrollKey, element.scrollTop);
    };
  }, [mainScroll, scrollKey]);

  // 首次进入时用设置里的持久列数作为页面滑块的起点；之后页面内调整只在本次会话生效。
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) {
      return;
    }
    seeded.current = true;
    setPosterColumns(posterSize);
  }, [posterSize, setPosterColumns]);

  const setSort = useCallback(
    (next: SortId) => {
      const params = new URLSearchParams(searchParams);
      params.set('sort', next);
      pushDemoPreference({ sort: next });
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const open = useCallback((workId: string) => navigate(`/work/${workId}`), [navigate]);

  const title =
    mode.kind === 'favorites'
      ? '我的收藏'
      : mode.kind === 'search'
        ? `搜索：${query || '全部'}`
        : (VIEW_TITLES[view] ?? '媒体库');

  if (library.isPending) {
    return <LoadingSurface label="正在载入媒体库" detail="正在读取演示数据" />;
  }
  // 失败但已有快照时保留最后有效视图（列表不清空、不伪装成空库）。
  if (library.isError && !library.data) {
    return (
      <ErrorSurface
        detail={library.error?.message ?? '演示数据读取失败'}
        onRetry={() => void library.refetch()}
      />
    );
  }

  return (
    <section className={styles.page} data-route={routeMarker(mode)}>
      {library.isRefetchError ? (
        <p
          className="m-0 rounded-md border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground"
          role="status"
        >
          刷新失败，当前显示上一次成功的数据：{library.error?.message ?? '未知错误'}
          <button type="button" className="ml-2 underline" onClick={() => void library.refetch()}>
            重试
          </button>
        </p>
      ) : null}
      <div className={styles.head}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{title}</h1>
          <span className={styles.count}>共 {sorted.length} 部</span>
          {remoteSearch.data?.truncated ? (
            // 后端命中数超过 limit 时如实提示，不把截断当成"没有更多结果"。
            <span className="text-[12px] text-muted-foreground" role="status">
              命中过多，仅显示前 {remoteSearch.data.hits.length} 条，请补充关键词缩小范围。
            </span>
          ) : null}
        </div>
        <div className={styles.toolbar} role="toolbar" aria-label="媒体库视图工具">
          {/* 列数滑块：只在会话内生效（与原型一致），持久值在设置 → 外观。 */}
          <div className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1">
            <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <Slider
              className="w-24"
              min={6}
              max={9}
              step={1}
              value={[posterColumns]}
              onValueChange={(values) => setPosterColumns(values[0] ?? posterColumns)}
              aria-label="海报墙列数"
            />
            <span className="w-8 text-right text-[12px] tabular-nums text-muted-foreground" aria-live="polite">
              {posterColumns} 列
            </span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="排序方式">
                {SORT_OPTIONS.find((option) => option.id === sort)?.label ?? '排序'}
                <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>排序方式</DropdownMenuLabel>
              {SORT_OPTIONS.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.id}
                  checked={sort === option.id}
                  onCheckedChange={() => setSort(option.id)}
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptySurface
          kicker={mode.kind === 'search' ? '搜索' : '媒体库'}
          title={
            mode.kind === 'view' && source !== 'all' ? '没有符合该来源的作品' : emptyTitle(mode, query)
          }
          detail={
            mode.kind === 'search'
              ? '换一个关键词，或清空搜索回到上一个界面。'
              : source !== 'all'
                ? '当前分类下没有来自该来源的内容，换一个来源或切回「全部来源」。'
                : '可以前往媒体管理导入新的来源。'
          }
          action={
            source !== 'all' ? (
              <Button variant="outline" onClick={() => setSource('all')}>
                切回全部来源
              </Button>
            ) : (
              <Button variant="outline" onClick={() => navigate('/manage')}>
                前往媒体管理
              </Button>
            )
          }
        />
      ) : (
        <PosterGrid
          works={sorted}
          onOpen={open}
          desiredColumns={posterColumns}
          imageMode={cardImageMode}
          scrollRef={mainScroll}
          emptyLabel="这个筛选下还没有作品"
        />
      )}
    </section>
  );
}

function routeMarker(mode: WallMode): string {
  if (mode.kind === 'favorites') {
    return 'favorites';
  }
  if (mode.kind === 'search') {
    return 'search';
  }
  return 'library';
}

function emptyTitle(mode: WallMode, query: string): string {
  if (mode.kind === 'favorites') {
    return '还没有收藏作品';
  }
  if (mode.kind === 'search') {
    return query ? `没有匹配「${query}」的作品` : '输入关键词开始搜索';
  }
  return '这个分类下还没有作品';
}

function matchesQuery(work: WorkSummary, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    work.title.toLowerCase().includes(needle) ||
    work.originalTitle.toLowerCase().includes(needle) ||
    work.genres.some((genre) => genre.includes(needle)) ||
    work.studios.some((studio) => studio.toLowerCase().includes(needle))
  );
}

function sortWorks(works: readonly WorkSummary[], sort: SortId): readonly WorkSummary[] {
  const sorted = [...works];
  switch (sort) {
    case 'titleDesc':
      return sorted.sort((left, right) => right.title.localeCompare(left.title, 'zh-Hans-CN'));
    case 'year':
      return sorted.sort((left, right) => right.year - left.year);
    case 'yearAsc':
      return sorted.sort((left, right) => left.year - right.year);
    case 'rating':
      return sorted.sort((left, right) => right.rating - left.rating);
    case 'ratingAsc':
      return sorted.sort((left, right) => left.rating - right.rating);
    case 'episodesDesc':
      return sorted.sort((left, right) => right.episodeCount - left.episodeCount);
    case 'episodesAsc':
      return sorted.sort((left, right) => left.episodeCount - right.episodeCount);
    case 'recent':
      return sorted.sort((left, right) =>
        (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''),
      );
    default:
      return sorted.sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));
  }
}
