/**
 * 公共框架：标题栏、侧栏与主滚动区。
 *
 * 复刻当前应用的信息密度与操作位置：侧栏承载媒体库入口与计数，
 * 标题栏承载返回/前进、来源筛选、全局搜索、任务入口与窗口控制，
 * 主内容区是唯一的滚动容器。
 */

import { Badge, Menu, TextInput, Tooltip } from '@mantine/core';
import {
  ArrowLeft,
  ArrowRight,
  CalendarSync,
  Clapperboard,
  Clock3,
  Film,
  Heart,
  Home,
  ListFilter,
  Loader2,
  MonitorPlay,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SlidersHorizontal,
  Tv,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NavLink, useLocation, useNavigate, useNavigationType } from 'react-router';

import { useLibrary } from '../shared/api/service-context';
import { SOURCE_LABELS, useUiStore, type SourceFilter } from '../app/ui-store';
import { useNavHistoryState, useRecordLocation } from '../app/nav-history';
import { remainingLabel } from '../shared/ui/PosterCard';
import type { LibraryView, WorkSummary } from '../shared/api/service';
import styles from './AppShell.module.css';

const MainScrollContext = createContext<{ readonly current: HTMLElement | null }>({ current: null });

export function useMainScroll(): { readonly current: HTMLElement | null } {
  return useContext(MainScrollContext);
}

interface SidebarItem {
  readonly key: string;
  readonly label: string;
  readonly to: string;
  readonly icon: LucideIcon;
  readonly view?: LibraryView;
}

const PRIMARY_ITEMS: readonly SidebarItem[] = [
  { key: 'home', label: '首页', to: '/', icon: Home },
  { key: 'favorites', label: '我的收藏', to: '/favorites', icon: Heart },
  { key: 'recent', label: '最近观看', to: '/recent', icon: Clock3 },
];

const LIBRARY_ITEMS: readonly SidebarItem[] = [
  { key: 'seasonal', label: '新番', to: '/library/seasonal', icon: CalendarSync, view: 'seasonal' },
  { key: 'anime_series', label: '番剧', to: '/library/anime_series', icon: Tv, view: 'anime_series' },
  { key: 'anime_movie', label: '动画电影', to: '/library/anime_movie', icon: Clapperboard, view: 'anime_movie' },
  { key: 'live_series', label: '剧集', to: '/library/live_series', icon: MonitorPlay, view: 'live_series' },
  { key: 'live_movie', label: '电影', to: '/library/live_movie', icon: Film, view: 'live_movie' },
];

export function AppShell({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  useRecordLocation(location.key, useNavigationType());
  const [main, setMain] = useState<HTMLElement | null>(null);
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const mainRef = useCallback((node: HTMLElement | null) => {
    setMain(node);
  }, []);

  return (
    <div className={styles.shell} data-sidebar={sidebarMode}>
      <TitleBar />
      <Sidebar />
      <main className={styles.main} ref={mainRef}>
        <div className={styles.content}>
          <MainScrollContext.Provider value={{ current: main }}>{children}</MainScrollContext.Provider>
        </div>
      </main>
    </div>
  );
}

function TitleBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { back, forward } = useNavHistoryState();
  const { source, setSource, toggleSidebarVisibility, sidebarMode } = useUiStore();
  const library = useLibrary();
  const [search, setSearch] = useState(() => searchValue(location.search));
  const [composing, setComposing] = useState(false);
  const lastNonSearch = useRef('/');
  const controls = typeof window === 'undefined' ? undefined : window.kumiplayer?.windowControls;

  useEffect(() => {
    if (!location.pathname.startsWith('/search')) {
      lastNonSearch.current = `${location.pathname}${location.search}`;
    }
    setSearch(searchValue(location.search));
  }, [location.pathname, location.search]);

  const applySearch = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        navigate(lastNonSearch.current, { replace: true });
        return;
      }
      const alreadySearching = location.pathname.startsWith('/search');
      navigate(`/search?q=${encodeURIComponent(trimmed)}`, { replace: alreadySearching });
    },
    [location.pathname, navigate],
  );

  const activeTasks = library.data?.sources.filter((card) => card.activeTaskId !== null).length ?? 0;
  const sourceLabel = SOURCE_LABELS.find((item) => item.value === source)?.label ?? '全部来源';

  return (
    <header className={styles.titlebar}>
      <div className={styles.titlebarLeading}>
        <Tooltip label={sidebarMode === 'hidden' ? '显示导航栏' : '完全隐藏导航栏'}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={toggleSidebarVisibility}
            aria-label={sidebarMode === 'hidden' ? '显示导航栏' : '完全隐藏导航栏'}
          >
            <PanelLeft aria-hidden="true" />
          </button>
        </Tooltip>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!back}
          onClick={() => navigate(-1)}
          aria-label="返回上个界面"
          title="返回上个界面"
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!forward}
          onClick={() => navigate(1)}
          aria-label="前进到下个界面"
          title="前进到下个界面"
        >
          <ArrowRight aria-hidden="true" />
        </button>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            K
          </span>
          <span className={styles.brandName}>KumiPlayer</span>
          <Badge size="xs" variant="light" className={styles.demoBadge}>
            演示模式
          </Badge>
        </div>
      </div>

      <div className={styles.titlebarTools}>
        <Menu shadow="md" position="bottom-end" withinPortal>
          <Menu.Target>
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`来源筛选，当前${sourceLabel}`}
              title={`来源：${sourceLabel}`}
              data-filtered={source !== 'all' ? 'true' : undefined}
            >
              <ListFilter aria-hidden="true" />
            </button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>来源筛选</Menu.Label>
            {SOURCE_LABELS.map((option) => (
              <Menu.Item
                key={option.value}
                onClick={() => setSource(option.value as SourceFilter)}
                rightSection={source === option.value ? '✓' : undefined}
              >
                {option.label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>

        <div className={styles.taskButtonWrap}>
          <Tooltip label="任务中心">
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => navigate('/tasks')}
              aria-label="任务中心"
            >
              {activeTasks > 0 ? (
                <Loader2 className={styles.spin} aria-hidden="true" />
              ) : (
                <SlidersHorizontal aria-hidden="true" />
              )}
            </button>
          </Tooltip>
          {activeTasks > 0 ? <span className={styles.taskDot} aria-hidden="true" /> : null}
        </div>

        <TextInput
          className={styles.search}
          value={search}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setSearch(value);
            if (!composing) {
              applySearch(value);
            }
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => {
            setComposing(false);
            applySearch(event.currentTarget.value);
          }}
          leftSection={<Search size={16} aria-hidden="true" />}
          rightSection={
            search.length > 0 ? (
              <button
                type="button"
                className={styles.searchClear}
                aria-label="清空搜索"
                onClick={() => {
                  setSearch('');
                  applySearch('');
                }}
              >
                <X size={15} aria-hidden="true" />
              </button>
            ) : null
          }
          placeholder="搜索作品"
          aria-label="搜索作品"
          radius="md"
        />
      </div>

      <div className={styles.windowControls}>
        <button type="button" className={styles.windowButton} aria-label="最小化" onClick={() => void controls?.minimize()}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6.5h8" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.windowButton}
          aria-label="最大化或还原"
          onClick={() => void controls?.toggleMaximize()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2.5" y="2.5" width="7" height="7" />
          </svg>
        </button>
        <button
          type="button"
          className={`${styles.windowButton} ${styles.windowClose}`}
          aria-label="关闭窗口"
          onClick={() => void controls?.close()}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m2.5 2.5 7 7m0-7-7 7" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function searchValue(search: string): string {
  return new URLSearchParams(search).get('q') ?? '';
}

function Sidebar() {
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const library = useLibrary();
  const expanded = sidebarMode === 'expanded';
  const works = library.data?.works ?? [];
  const countFor = (view: LibraryView): number => works.filter((work) => matchView(work, view)).length;
  const nextUp = works
    .filter((work) => work.progress && !work.progress.completed)
    .sort((left, right) => (right.progress?.updatedAt ?? '').localeCompare(left.progress?.updatedAt ?? ''))
    .slice(0, 1);

  return (
    <aside
      className={styles.sidebar}
      data-expanded={expanded ? 'true' : 'false'}
      aria-hidden={sidebarMode === 'hidden'}
    >
      <button
        type="button"
        className={styles.sidebarHeader}
        onClick={toggleSidebar}
        aria-expanded={expanded}
        aria-label={expanded ? '收起为图标栏' : '展开完整侧栏'}
      >
        <span className={styles.sidebarHeaderLabel}>媒体库</span>
        <span className={styles.sidebarHeaderIcon} aria-hidden="true">
          {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
        </span>
      </button>

      <nav className={styles.nav} aria-label="媒体库导航">
        {PRIMARY_ITEMS.map((item) => (
          <SidebarLink key={item.key} item={item} expanded={expanded} />
        ))}
        <span className={styles.divider} aria-hidden="true" />
        {LIBRARY_ITEMS.map((item) => (
          <SidebarLink
            key={item.key}
            item={item}
            expanded={expanded}
            count={item.view ? countFor(item.view) : undefined}
          />
        ))}
      </nav>

      <div className={styles.sidebarBottom}>
        <span className={styles.divider} aria-hidden="true" />
        <SidebarLink
          item={{ key: 'manage', label: '媒体管理', to: '/manage', icon: SlidersHorizontal }}
          expanded={expanded}
        />
        <SidebarLink
          item={{ key: 'settings', label: '设置', to: '/settings', icon: Settings }}
          expanded={expanded}
        />
        {expanded && nextUp[0] ? (
          <div className={styles.continueCard} title={nextUp[0].title}>
            <span className={styles.continueLabel}>继续观看</span>
            <span className={styles.continueTitle}>{nextUp[0].title}</span>
            <span className={styles.continueMeta}>{remainingLabel(nextUp[0])}</span>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function SidebarLink({
  item,
  expanded,
  count,
}: {
  readonly item: SidebarItem;
  readonly expanded: boolean;
  readonly count?: number;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) => (isActive ? `${styles.navItem} ${styles.navItemActive}` : styles.navItem)}
      title={expanded ? undefined : item.label}
    >
      <span className={styles.navIcon} aria-hidden="true">
        <Icon />
      </span>
      <span className={styles.navLabel}>{item.label}</span>
      {expanded && typeof count === 'number' ? <span className={styles.navCount}>{count}</span> : null}
    </NavLink>
  );
}

/** 分类归属只按演示条目的展示类型判定，不重做真实识别规则。 */
export function matchView(work: WorkSummary, view: LibraryView): boolean {
  switch (view) {
    case 'seasonal':
      return work.watch.status === 'watching' || work.watch.status === 'on_hold';
    case 'anime_series':
      return work.showType === 'anime_series';
    case 'anime_movie':
      return work.showType === 'anime_movie';
    case 'live_series':
      return work.showType === 'live_series';
    case 'live_movie':
      return work.showType === 'live_movie';
    default:
      return false;
  }
}
