/**
 * 公共应用框架：顶栏、侧栏与主滚动区。
 *
 * 使用 shadcn/ui 源码组件与 Tailwind 组织交互与外观；布局细节留在 CSS Module。
 * 宿主能力（窗口控件、拖拽区）由 platform 适配层决定：浏览器里不渲染，
 * 避免出现点了没反应的假窗口按钮。
 */

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
  Menu as MenuIcon,
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
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useNavigationType } from 'react-router';

import { SOURCE_LABELS, useUiStore, type SourceFilter } from '@/app/ui-store';
import { useNavHistoryState, useRecordLocation } from '@/app/nav-history';
import { detectHost } from '@/app/platform';
import { useLibrary } from '@/shared/api/service-context';
import type { LibraryView, WorkSummary } from '@/shared/api/service';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { Input } from '@/shared/ui/input';
import { Separator } from '@/shared/ui/separator';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { CommandPalette } from './CommandPalette';
import { MainScrollContext } from './main-scroll';
import styles from './AppShell.module.css';

export { useMainScroll } from './main-scroll';

interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly to: string;
  readonly icon: LucideIcon;
  readonly view?: LibraryView;
}

const PRIMARY: readonly NavItem[] = [
  { key: 'home', label: '首页', to: '/', icon: Home },
  { key: 'favorites', label: '我的收藏', to: '/favorites', icon: Heart },
  { key: 'recent', label: '最近观看', to: '/recent', icon: Clock3 },
];

const LIBRARY: readonly NavItem[] = [
  { key: 'seasonal', label: '新番', to: '/library/seasonal', icon: CalendarSync, view: 'seasonal' },
  { key: 'anime_series', label: '番剧', to: '/library/anime_series', icon: Tv, view: 'anime_series' },
  { key: 'anime_movie', label: '动画电影', to: '/library/anime_movie', icon: Clapperboard, view: 'anime_movie' },
  { key: 'live_series', label: '剧集', to: '/library/live_series', icon: MonitorPlay, view: 'live_series' },
  { key: 'live_movie', label: '电影', to: '/library/live_movie', icon: Film, view: 'live_movie' },
];

const BOTTOM: readonly NavItem[] = [
  { key: 'manage', label: '媒体管理', to: '/manage', icon: SlidersHorizontal },
  { key: 'settings', label: '设置', to: '/settings', icon: Settings },
];

export function AppShell({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  useRecordLocation(location.key, useNavigationType());
  const [main, setMain] = useState<HTMLElement | null>(null);
  // 窄窗没有常驻侧栏，用抽屉承载同一套导航。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const library = useLibrary();
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const mainRef = useCallback((node: HTMLElement | null) => setMain(node), []);

  // Ctrl/Cmd+K 唤起快捷搜索；只拦截组合键，不影响普通输入与输入法组合。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className={styles.shell} data-sidebar={sidebarMode}>
      <TitleBar onOpenDrawer={() => setDrawerOpen(true)} />
      <Sidebar />
      <main className={styles.main} ref={mainRef} data-testid="main-scroll">
        <div className={styles.content}>
          <MainScrollContext.Provider value={{ current: main }}>{children}</MainScrollContext.Provider>
        </div>
      </main>
      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent className={styles.drawer} showClose={false} aria-describedby={undefined}>
          <DialogTitle className="sr-only">导航</DialogTitle>
          <NavList expanded onNavigate={() => setDrawerOpen(false)} />
        </DialogContent>
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        works={library.data?.works ?? []}
        onOpenWork={(workId) => navigate(`/work/${workId}`)}
      />
    </div>
  );
}

function TitleBar({ onOpenDrawer }: { readonly onOpenDrawer: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const host = detectHost();
  const { back, forward } = useNavHistoryState();
  const { source, setSource, sidebarMode, toggleSidebarVisibility } = useUiStore();
  const library = useLibrary();
  const [search, setSearch] = useState(() => searchValue(location.search));
  const [composing, setComposing] = useState(false);
  const lastNonSearch = useRef('/');

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
      navigate(`/search?q=${encodeURIComponent(trimmed)}`, {
        replace: location.pathname.startsWith('/search'),
      });
    },
    [location.pathname, navigate],
  );

  const activeTasks = library.data?.sources.filter((card) => card.activeTaskId !== null).length ?? 0;
  const sourceLabel = SOURCE_LABELS.find((item) => item.value === source)?.label ?? '全部来源';

  return (
    <header className={styles.titlebar} data-drag={host.canDragWindow ? 'true' : undefined}>
      <div className={styles.titlebarGroup} data-no-drag="true">
        <Button
          variant="ghost"
          size="icon-sm"
          className="lg:hidden"
          aria-label="打开导航"
          title="打开导航"
          onClick={onOpenDrawer}
        >
          <MenuIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hidden lg:inline-flex"
          aria-label={sidebarMode === 'hidden' ? '显示导航栏' : '完全隐藏导航栏'}
          title={sidebarMode === 'hidden' ? '显示导航栏' : '完全隐藏导航栏'}
          onClick={toggleSidebarVisibility}
        >
          <PanelLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="返回上个界面"
          title="返回上个界面"
          disabled={!back}
          onClick={() => navigate(-1)}
        >
          <ArrowLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="前进到下个界面"
          title="前进到下个界面"
          disabled={!forward}
          onClick={() => navigate(1)}
        >
          <ArrowRight />
        </Button>

        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            K
          </span>
          <span className={styles.brandName}>KumiPlayer</span>
          <Badge variant="soft" className="hidden sm:inline-flex">
            演示模式
          </Badge>
        </div>
      </div>

      <div className={styles.titlebarTools} data-no-drag="true">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant={source === 'all' ? 'ghost' : 'subtle'}
              size="icon-sm"
              aria-label={`来源筛选，当前${sourceLabel}`}
              title={`来源：${sourceLabel}`}
            >
              <ListFilter />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>来源筛选</DropdownMenuLabel>
            {SOURCE_LABELS.map((option) => (
              <DropdownMenuCheckboxItem
                key={option.value}
                checked={source === option.value}
                onCheckedChange={() => setSource(option.value as SourceFilter)}
              >
                {option.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={`任务中心${activeTasks > 0 ? `，${activeTasks} 个进行中` : ''}`}
          title="任务中心"
          onClick={() => navigate('/tasks')}
        >
          {activeTasks > 0 ? <Loader2 className="animate-spin" /> : <SlidersHorizontal />}
          {activeTasks > 0 ? (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-primary" aria-hidden="true" />
          ) : null}
        </Button>

        <div className="relative w-[min(300px,32vw)]">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-8 pl-8"
            value={search}
            placeholder="搜索作品  (Ctrl+K)"
            aria-label="搜索作品"
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
          />
          {search.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-0.5 right-0.5 size-7"
              aria-label="清空搜索"
              onClick={() => {
                setSearch('');
                applySearch('');
              }}
            >
              <X />
            </Button>
          ) : null}
        </div>
      </div>

      {host.hasWindowControls ? (
        <div className={styles.windowControls} data-no-drag="true">
          <button
            type="button"
            className={styles.windowButton}
            aria-label="最小化"
            onClick={() => void window.kumiplayer?.windowControls?.minimize()}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6.5h8" />
            </svg>
          </button>
          <button
            type="button"
            className={styles.windowButton}
            aria-label="最大化或还原"
            onClick={() => void window.kumiplayer?.windowControls?.toggleMaximize()}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <rect x="2.5" y="2.5" width="7" height="7" />
            </svg>
          </button>
          <button
            type="button"
            className={`${styles.windowButton} ${styles.windowClose}`}
            aria-label="关闭窗口"
            onClick={() => void window.kumiplayer?.windowControls?.close()}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m2.5 2.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
      ) : null}
    </header>
  );
}

function searchValue(search: string): string {
  return new URLSearchParams(search).get('q') ?? '';
}

function Sidebar() {
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const expanded = sidebarMode === 'expanded';

  return (
    <aside
      className={styles.sidebar}
      data-expanded={expanded ? 'true' : 'false'}
      aria-hidden={sidebarMode === 'hidden'}
    >
      <div className={styles.sidebarHeader}>
        <button
          type="button"
          className={styles.sidebarHeaderButton}
          onClick={toggleSidebar}
          aria-expanded={expanded}
          aria-label={expanded ? '收起为图标栏' : '展开完整侧栏'}
        >
          <span className={styles.sidebarHeaderLabel}>媒体库</span>
          <span className={styles.sidebarHeaderIcon} aria-hidden="true">
            {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
          </span>
        </button>
      </div>
      <NavList expanded={expanded} />
    </aside>
  );
}

/** 侧栏与窄窗抽屉共用同一份导航，避免两套入口漂移。 */
function NavList({
  expanded,
  onNavigate,
}: {
  readonly expanded: boolean;
  readonly onNavigate?: () => void;
}) {
  const library = useLibrary();
  const works = library.data?.works ?? [];
  const countFor = (view: LibraryView) => works.filter((work) => matchView(work, view)).length;

  return (
    <>
      <nav className={styles.nav} aria-label="媒体库导航">
        {PRIMARY.map((item) => (
          <SidebarLink key={item.key} item={item} expanded={expanded} onNavigate={onNavigate} />
        ))}
        <Separator className="my-2" />
        {LIBRARY.map((item) => (
          <SidebarLink
            key={item.key}
            item={item}
            expanded={expanded}
            count={item.view ? countFor(item.view) : undefined}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      <div className={styles.sidebarBottom}>
        <Separator className="mb-2" />
        {BOTTOM.map((item) => (
          <SidebarLink key={item.key} item={item} expanded={expanded} onNavigate={onNavigate} />
        ))}
      </div>
    </>
  );
}

function SidebarLink({
  item,
  expanded,
  count,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly expanded: boolean;
  readonly count?: number;
  readonly onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      onClick={onNavigate}
      className={({ isActive }) => (isActive ? styles.navItemActive : styles.navItem)}
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

