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
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Clock3,
  Film,
  Heart,
  Home,
  ListFilter,
  Menu as MenuIcon,
  MonitorPlay,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Tv,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { NavLink, useLocation, useNavigate, useNavigationType } from 'react-router';

import { SOURCE_LABELS, useUiStore, type SourceFilter } from '@/app/ui-store';
import { useNavHistoryState, useRecordLocation } from '@/app/nav-history';
import { detectHost } from '@/app/platform';
import { demoQueryKeys, useLibrary } from '@/shared/api/service-context';
import { useQueryClient } from '@tanstack/react-query';
import { useDemoState } from '@/mock/demo-store';
import type { LibraryView, WorkSummary } from '@/shared/api/service';
import { Avatar, AvatarFallback } from '@/shared/ui/avatar';
import { Button } from '@/shared/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { LiquidSurface } from '@/shared/ui/LiquidSurface';
import { Separator } from '@/shared/ui/separator';
import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/dialog';
import { CommandPalette } from './CommandPalette';
import { FirstRunSetup } from '@/features/setup/FirstRunSetup';
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
  const [titlebarHidden, setTitlebarHidden] = useState(false);
  const [titlebarPeeking, setTitlebarPeeking] = useState(false);
  const restoreTitlebarRef = useRef<HTMLButtonElement>(null);
  const toggleTitlebarRef = useRef<HTMLButtonElement>(null);
  const toggleTitlebar = () => {
    setTitlebarHidden(!titlebarHidden);
    setTitlebarPeeking(false);
    requestAnimationFrame(() => (titlebarHidden ? toggleTitlebarRef : restoreTitlebarRef).current?.focus({ preventScroll: true }));
  };
  const library = useLibrary();
  const setupOpen = useUiStore((state) => state.setupOpen);
  const openSetup = useUiStore((state) => state.openSetup);
  const closeSetup = useUiStore((state) => state.closeSetup);
  const application = useDemoState().settings.application;
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const mainRef = useCallback((node: HTMLElement | null) => setMain(node), []);

  // 主滚动区跨路由复用，不能把上一页的偏移带进新页面。
  // 用被动 effect 留出旧页面保存位置的机会；海报墙随后按自身筛选恢复位置。
  useEffect(() => {
    if (main) main.scrollTop = 0;
  }, [main, location.pathname]);

  // 首次使用引导只在"未完成且未推迟"时自动打开一次；关掉后不会反复弹出。
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || setupOpen || application.setupCompleted || application.setupDeferred) {
      return;
    }
    autoOpened.current = true;
    openSetup();
  }, [application.setupCompleted, application.setupDeferred, openSetup, setupOpen]);

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
    <div className={styles.shell} data-sidebar={sidebarMode} data-titlebar={titlebarHidden ? 'hidden' : 'full'} data-titlebar-peeking={titlebarPeeking}>
      <TitleBar onOpenDrawer={() => setDrawerOpen(true)} titlebarHidden={titlebarHidden}
        onToggleTitlebar={toggleTitlebar} onPeekChange={setTitlebarPeeking} toggleRef={toggleTitlebarRef} />
      {titlebarHidden ? <>
      <div className={styles.titlebarHotzone} aria-hidden="true" onPointerEnter={() => setTitlebarPeeking(true)} />
      <Button ref={restoreTitlebarRef} variant="outline" size="icon-sm"
        className={styles.restoreTitlebar} aria-label="展开顶栏" title="展开顶栏"
        onClick={toggleTitlebar}>
        <ChevronDown aria-hidden="true" />
      </Button></> : null}
      <Sidebar onOpenSearch={() => setPaletteOpen(true)} />
      <main className={styles.main} ref={mainRef} data-testid="main-scroll">
        <div className={styles.content}>
          <MainScrollContext.Provider value={{ current: main }}>{children}</MainScrollContext.Provider>
        </div>
      </main>
      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent className={styles.drawer} showClose={false} aria-describedby={undefined}>
          <DialogTitle className="sr-only">导航</DialogTitle>
          <Button variant="ghost" onClick={() => { setDrawerOpen(false); setPaletteOpen(true); }}>
            <Search aria-hidden="true" /> 搜索作品
          </Button>
          <NavList expanded onNavigate={() => setDrawerOpen(false)} />
        </DialogContent>
      </Dialog>
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        works={library.data?.works ?? []}
        onOpenWork={(workId) => navigate(`/work/${workId}`)}
      />
      <FirstRunSetup
        open={setupOpen}
        onClose={closeSetup}
        mode={application.setupCompleted ? 'reconfigure' : 'first-run'}
      />
    </div>
  );
}

function TitleBar({ onOpenDrawer, titlebarHidden, onToggleTitlebar, onPeekChange, toggleRef }: {
  readonly onOpenDrawer: () => void;
  readonly titlebarHidden: boolean;
  readonly onToggleTitlebar: () => void;
  readonly onPeekChange: (peek: boolean) => void;
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
}) {
  const navigate = useNavigate();
  const host = detectHost();
  const queryClient = useQueryClient();
  const { back, forward } = useNavHistoryState();
  const { sidebarMode, toggleSidebarVisibility } = useUiStore();

  return (
    <header data-material-surface="chrome" className={styles.titlebar} data-drag={host.canDragWindow ? 'true' : undefined}
      onPointerEnter={() => { if (titlebarHidden) onPeekChange(true); }}
      onPointerLeave={() => onPeekChange(false)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onPeekChange(false); }}>
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
        {/* 原型顺序：完全隐藏 → 返回 → 前进 → 刷新 → 品牌 → 当前上下文。 */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="刷新媒体库"
          title="刷新媒体库"
          onClick={() => void queryClient.invalidateQueries({ queryKey: demoQueryKeys.library })}
        >
          <RefreshCw />
        </Button>

        <div className={styles.brand}>
          <span className={styles.brandName}>KumiPlayer</span>
        </div>
      </div>

      <div className={styles.titlebarChrome} data-no-drag="true">
        <Button ref={toggleRef} variant="ghost" size="icon-sm" onClick={onToggleTitlebar}
          aria-pressed={titlebarHidden} aria-label={titlebarHidden ? '固定展开顶栏' : '收起顶栏'}
          title={titlebarHidden ? '固定展开顶栏' : '收起顶栏'}>
          {titlebarHidden ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
        </Button>
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

function Sidebar({ onOpenSearch }: { readonly onOpenSearch: () => void }) {
  const sidebarMode = useUiStore((state) => state.sidebarMode);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const source = useUiStore((state) => state.source);
  const setSource = useUiStore((state) => state.setSource);
  const expanded = sidebarMode === 'expanded';
  const sourceLabel = SOURCE_LABELS.find((item) => item.value === source)?.label ?? '全部来源';

  return (
    <aside
      className={styles.sidebar}
      data-material-surface="chrome"
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
          <span className={styles.sidebarHeaderLine} aria-hidden="true" />
          <span className={styles.sidebarHeaderIcon} aria-hidden="true">
            {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
          </span>
        </button>
      </div>
      {/* 搜索入口与来源筛选只在展开态出现（原型契约）；收起后使用 Ctrl+K 唤起搜索。 */}
        <div className={styles.sidebarTools}>
          <button type="button" data-material-surface="lens" className={styles.sidebarSearch} onClick={onOpenSearch} aria-label="搜索作品（Ctrl+K）">
            <LiquidSurface />
            <Search aria-hidden="true" />
            <span className={styles.sidebarSearchText}>搜索作品</span>
            <kbd className={styles.sidebarSearchKbd}>Ctrl K</kbd>
          </button>
          {expanded ? <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={styles.sidebarToolButton}
                data-active={source === 'all' ? 'false' : 'true'}
                aria-label={`来源筛选，当前${sourceLabel}`}
                title={`来源：${sourceLabel}`}
              >
                <ListFilter aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
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
          </DropdownMenu> : null}
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
        {/* 本地账户入口：浏览器版本没有登录能力，只显示本机身份，不造假登录态。 */}
        <div className={styles.sidebarUser} aria-label="本机账户">
          <Avatar className={styles.sidebarUserAvatar} aria-hidden="true">
            <AvatarFallback>K</AvatarFallback>
          </Avatar>
          <span className={styles.sidebarUserText}>
            <span className={styles.sidebarUserName}>Kumi</span>
          </span>
        </div>
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

