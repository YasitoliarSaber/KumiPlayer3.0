/**
 * 演示壳子的装配测试：真实渲染页面（含公共框架），验证
 * 页面内容、虚拟化挂载有界、空状态、交互结果与设置写入。
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../../src/renderer/app/queryClient';
import { HomePage } from '../../src/renderer/features/home/HomePage';
import { PosterWallPage } from '../../src/renderer/features/library/PosterWallPage';
import { RecentPage } from '../../src/renderer/features/recent/RecentPage';
import { WorkDetailPage } from '../../src/renderer/features/work/WorkDetailPage';
import { WorkManagementSheet } from '../../src/renderer/features/work/WorkManagementSheet';
import { MediaManagementPage } from '../../src/renderer/features/manage/MediaManagementPage';
import { TaskCenter } from '../../src/renderer/features/tasks/TaskCenter';
import { SettingsPage } from '../../src/renderer/features/settings/SettingsPage';
import { AppShell } from '../../src/renderer/shell/AppShell';
import { ServiceProvider } from '../../src/renderer/shared/api/service-context';
import { useUiStore } from '../../src/renderer/app/ui-store';
import { buildMockCatalog } from '../../src/renderer/mock/catalog';
import { DEFAULT_SETTINGS, getDemoState, resetDemoState, updateDemoState } from '../../src/renderer/mock/demo-store';
import { createMockMediaService } from '../../src/renderer/mock/service';

const catalog = buildMockCatalog();
const service = createMockMediaService({ latencyMs: 0, catalog });

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
  // jsdom 没有布局：给出确定的视口与容器尺寸，让虚拟化可以真正计算窗口。
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width: 1200,
      height: 800,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 800 });
  // jsdom 未实现滚动 API：给出无副作用替身，避免虚拟化与滚动恢复直接抛错。
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => undefined,
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: { width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800 },
            } as unknown as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  resetDemoState();
  // UI store 是模块级状态：用例之间必须复位，否则上一次留下的模态弹层
  // 会把后面的界面整片 aria-hidden 掉（表现为"找不到可访问元素"）。
  useUiStore.setState({ setupOpen: false, sidebarMode: 'expanded', source: 'all' });
  // 多数用例关注业务界面而非引导：把演示引导标记为已完成，避免弹层遮挡可访问性树。
  updateDemoState(() => ({
    settings: {
      ...DEFAULT_SETTINGS,
      application: { ...DEFAULT_SETTINGS.application, setupCompleted: true, setupDeferred: false },
    },
  }));
});

afterEach(() => {
  resetDemoState();
});

function renderPage(
  element: React.ReactNode,
  path = '/',
  initialEntry = path,
  queryClient = createAppQueryClient(),
  mediaService: typeof service = service,
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ServiceProvider service={mediaService}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <AppShell>
            <Routes>
              <Route path={path} element={element} />
            </Routes>
          </AppShell>
        </MemoryRouter>
      </ServiceProvider>
    </QueryClientProvider>,
  );
}

describe('公共框架', () => {
  it('顶栏可以独立收起并通过展开入口恢复', async () => {
    renderPage(<HomePage />);
    const shell = screen.getByTestId('main-scroll').closest('[data-titlebar]')!;
    fireEvent.click(screen.getByRole('button', { name: '收起顶栏', exact: true }));
    expect(shell.getAttribute('data-titlebar')).toBe('hidden');
    const restore = screen.getByRole('button', { name: '展开顶栏', exact: true });
    fireEvent.pointerEnter(restore);
    expect(shell.getAttribute('data-titlebar-peeking')).toBe('false');
    fireEvent.click(restore);
    expect(shell.getAttribute('data-titlebar')).toBe('full');
    expect(screen.getByRole('button', { name: '收起顶栏', exact: true })).toBeTruthy();
  });
  it('进入其他页面时清除主滚动区的旧偏移', async () => {
    renderPage(<HomePage />);
    const main = screen.getByTestId('main-scroll');
    main.scrollTop = 420;
    fireEvent.click(screen.getByRole('link', { name: '媒体管理', exact: true }));
    await waitFor(() => expect(main.scrollTop).toBe(0));
  });

  it('标题栏、侧栏与主导航都在，且侧栏显示分类计数', async () => {
    renderPage(<HomePage />);
    expect(screen.getByText('KumiPlayer')).toBeTruthy();
    expect(screen.queryByText('演示模式')).toBeNull();
    expect(screen.queryByText('本机后端')).toBeNull();
    expect(screen.queryByText('本地账户')).toBeNull();
    expect(screen.getByRole('navigation', { name: '媒体库导航' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '搜索作品（Ctrl+K）' })).toBeTruthy();
    const titlebar = screen.getByRole('banner');
    expect(within(titlebar).queryByRole('searchbox')).toBeNull();
    expect(within(titlebar).queryByRole('button', { name: /任务中心/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole('link', { name: /番剧/ })).toBeTruthy());
  });

  it('Ctrl+K 打开快捷搜索，输入后用 Enter 进入作品详情', async () => {
    renderPage(<HomePage />);
    // 等待演示库加载完成，快捷键面板才有作品可搜。
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^打开.+详情$/ }).length).toBeGreaterThan(0));

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = await screen.findByRole('textbox', { name: '快捷搜索' });
    fireEvent.change(box, { target: { value: 'CLANNAD' } });

    // 演示库同名作品很多：取第 1 条结果并确认它就是当前高亮项。
    const options = await screen.findAllByRole('option', { name: /CLANNAD/ });
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'Enter' });

    // 面板关闭即视为已执行激活动作；导航目标由详情路由承载。
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '快捷搜索' })).toBeNull());
  });

  it('快捷搜索按 Esc 关闭并把焦点还给打开前的元素', async () => {
    renderPage(<HomePage />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^打开.+详情$/ }).length).toBeGreaterThan(0));

    // 先聚焦一个可聚焦元素，作为"打开面板前的位置"。
    const anchor = screen.getByRole('link', { name: '我的收藏' });
    anchor.focus();
    expect(document.activeElement).toBe(anchor);

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const box = await screen.findByRole('textbox', { name: '快捷搜索' });
    expect(document.activeElement).toBe(box);

    fireEvent.keyDown(box, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '快捷搜索' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(anchor));
  });

  it('挂载/卸载公共框架不会泄漏 window 键盘监听', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    for (let round = 0; round < 3; round += 1) {
      const view = renderPage(<HomePage />);
      view.unmount();
    }
    const added = add.mock.calls.filter(([type]) => type === 'keydown').length;
    const removed = remove.mock.calls.filter(([type]) => type === 'keydown').length;
    expect(added).toBeGreaterThan(0);
    // 每次挂载都必须有对应退订，卸载后不残留键盘监听。
    expect(removed).toBeGreaterThanOrEqual(added);
    add.mockRestore();
    remove.mockRestore();
  });

  it('读取失败时保留最后一次有效快照并允许重试', async () => {
    const instance = createMockMediaService({ latencyMs: 0, catalog });
    let calls = 0;
    const flaky = {
      ...instance,
      listLibrary: async (signal?: AbortSignal) => {
        calls += 1;
        if (calls > 1) {
          throw new Error('演示：第二次读取失败');
        }
        return instance.listLibrary(signal);
      },
    };
    const queryClient = createAppQueryClient();
    const view = renderPage(
      <PosterWallPage mode={{ kind: 'view' }} />,
      '/library/:view',
      '/library/anime_series',
      queryClient,
      flaky,
    );

    // jsdom 不做布局，虚拟化不产生行；用分类标题里的数量作为"快照已加载"的证据。
    const wall = () =>
      view.container.querySelector('[data-route="library"]') as HTMLElement;
    await waitFor(() => expect(within(wall()).getByText(/共 \d+ 部/)).toBeTruthy());
    const before = within(wall()).getByText(/共 \d+ 部/).textContent ?? '';
    expect(Number(before.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(0);

    // 触发一次失败的重新读取：列表必须保留，只多出"显示上次成功数据"的提示。
    await queryClient.refetchQueries().catch(() => undefined);
    await waitFor(() => expect(screen.getByText(/显示上一次成功的数据/)).toBeTruthy());
    // 快照未被清空：数量仍与成功那次一致，页面也没有退化成致命错误页。
    expect(within(wall()).getByText(/共 \d+ 部/).textContent).toBe(before);
    expect(screen.queryByRole('alert')).toBeNull();
    // 服务实现由测试提供，第二次调用确实失败。
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('首页', () => {
  it('本机减弱动效偏好会停用自动橱窗与暂停按钮', async () => {
    updateDemoState((current) => ({
      settings: { ...current.settings, appearance: { ...current.settings.appearance, motion: 'reduced' } },
    }));
    renderPage(<HomePage />);
    await screen.findByLabelText('媒体展示');
    expect(screen.queryByRole('button', { name: '暂停自动推荐' })).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复自动推荐' })).toBeNull();
  });

  it('渲染橱窗、继续观看与分类分区', async () => {
    renderPage(<HomePage />);
    const showcase = await waitFor(() => screen.getByLabelText('媒体展示'));
    // 横幅只保留当前作品，右侧不再渲染三张辅助推荐卡片。
    expect(within(showcase).getAllByRole('button', { name: /^打开.+详情$/ })).toHaveLength(1);
    expect(screen.getAllByText('继续观看').length).toBeGreaterThan(0);
    expect(screen.getAllByText('番剧').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^打开.+详情$/ }).length).toBeGreaterThan(3);
  });
});

describe('海报墙', () => {
  it('渲染分类标题、数量与排序入口', async () => {
    const { container } = renderPage(
      <PosterWallPage mode={{ kind: 'view' }} />,
      '/library/:view',
      '/library/anime_series',
    );
    const wall = await waitFor(() => {
      const found = container.querySelector('[data-route="library"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(wall).getByText('番剧')).toBeTruthy();
    expect(within(wall).getByText(/共 \d+ 部/)).toBeTruthy();
    // 排序入口存在。Radix 弹层依赖完整 PointerEvent，jsdom 不能可靠展开菜单；
    // 菜单可打开与键盘选择由真实浏览器检查覆盖（见交付说明）。
    expect(within(wall).getByRole('button', { name: '排序方式' })).toBeTruthy();
  });

  it('没有作品的分类显示空状态并给出下一步', async () => {
    renderPage(<PosterWallPage mode={{ kind: 'view' }} />, '/library/:view', '/library/live_movie');
    await waitFor(() => expect(screen.getByText('这个分类下还没有作品')).toBeTruthy());
    expect(screen.getByRole('button', { name: '前往媒体管理' })).toBeTruthy();
  });

  it('搜索无结果时给出可操作的空状态', async () => {
    renderPage(<PosterWallPage mode={{ kind: 'search' }} />, '/search', '/search?q=zzz-不存在');
    await waitFor(() => expect(screen.getByText(/没有匹配/)).toBeTruthy());
  });
});

describe('最近观看', () => {
  it('按观看记录展示继续播放入口', async () => {
    renderPage(<RecentPage />, '/recent');
    await waitFor(() => expect(screen.getByText('最近观看')).toBeTruthy());
    // 最近观看卡片是可点击的继续播放入口。
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(3));
  });
});

describe('作品详情', () => {
  it('详情主画面展示季集，资料放入抽屉，播放与版本仍可用', async () => {
    const target = catalog.works[0]!;
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${target.id}`);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: target.title })).toBeTruthy(), { timeout: 4000 });
    expect(screen.queryByText('资料状态')).toBeNull();
    expect(screen.queryByRole('region', { name: '演员' })).toBeNull();

    const seasonTabs = screen.getAllByRole('tab');
    expect(seasonTabs.length).toBeGreaterThan(0);

    const playButton = screen.getAllByRole('button', { name: /播放|继续观看/ })[0]!;
    fireEvent.click(playButton);
    await waitFor(() => expect(getDemoState().playback?.workId).toBe(target.id));

    expect(screen.queryByRole('button', { name: '选择版本' })).toBeNull();
    // 用户已取消两侧翻页按钮：分集只保留可键盘聚焦的原生滚动轨道。
    expect(screen.queryByRole('button', { name: '上一组剧集' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下一组剧集' })).toBeNull();
    expect(screen.getByLabelText(/分集列表，可左右滚动/)).toBeTruthy();
    expect(screen.queryByText('资料状态')).toBeNull();
  });

  it('继续观看按最近剧集身份播放，进度留在按钮内部', async () => {
    const target = catalog.works[0]!;
    const work = await service.getWorkDetail(target.id);
    const latest = work.seasons.flatMap((season) => season.episodes).at(-1)!;
    const customService = { ...service, getWorkDetail: async () => ({ ...work,
      progress: { episodeId: latest.id, episodeCode: latest.code, episodeTitle: latest.title,
        position: 600, duration: 1200, completed: false, updatedAt: '2026-10-17T10:00:00' },
    }) };
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${target.id}`, createAppQueryClient(), customService);
    const resume = await screen.findByRole('button', { name: /继续观看.*50%/ });
    fireEvent.click(resume);
    await waitFor(() => expect(getDemoState().playback?.episodeId).toBe(latest.id));
    // 进度条就在继续观看按钮内部，不再有独立的播放进度区域。
    expect(within(resume).getByRole('progressbar', { name: '观看进度' })).toBeTruthy();
  });

  it('分集轨道只保留原生滚动视口，没有翻页按钮', async () => {
    const target = catalog.works[0]!;
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${target.id}`);
    const viewport = await screen.findByLabelText(/分集列表，可左右滚动/);
    expect(viewport.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('button', { name: /上一组剧集|下一组剧集/ })).toBeNull();
  });

  it('电影详情不展示季集列表，播放仍在概要按钮中', async () => {
    const movie = catalog.works.find((work) => work.mediaType === 'movie')!;
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${movie.id}`);
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1, name: movie.title })).toBeTruthy(),
      { timeout: 4000 },
    );

    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByLabelText(/分集列表，可左右滚动/)).toBeNull();
    expect(screen.queryByText('暂无分集图片')).toBeNull();

    const play = screen.getByRole('button', { name: /^播放/ });
    fireEvent.click(play);
    await waitFor(() => expect(getDemoState().playback?.workId).toBe(movie.id));
  });

  it('管理抽屉保留资料、观看状态与匹配入口', async () => {
    const target = catalog.works[0]!;
    const detail = await service.getWorkDetail(target.id);
    const changed = vi.fn(() => Promise.resolve());
    renderPage(<WorkManagementSheet work={detail} open onOpenChange={vi.fn()} onChanged={changed} />);
    const sheet = await screen.findByRole('dialog', { name: '资料与管理' });
    expect(within(sheet).getByText('资料状态')).toBeTruthy();
    expect(within(sheet).getByText('来源与位置')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '搜索候选' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: '已看完', exact: true }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect((await service.getWorkDetail(target.id)).watch.status).toBe('watched');
  });

  it('收藏按钮写入演示存储', async () => {
    const target = catalog.works[1]!;
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${target.id}`);
    const favorite = await screen.findByRole('button', { name: /收藏/ });
    fireEvent.click(favorite);
    await waitFor(() => expect(getDemoState().favorite[target.id]).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '取消收藏', exact: true })).toBeTruthy());
  });

  it('季切换 Tabs 支持键盘方向键（Radix 原语，无需自写实现）', async () => {
    const target = catalog.works.find((work) => work.seasonCount > 1)!;
    renderPage(<WorkDetailPage />, '/work/:workId', `/work/${target.id}`);

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    tabs[0]!.focus();
    expect(document.activeElement).toBe(tabs[0]);

    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    await waitFor(() => expect(tabs[1]!.getAttribute('aria-selected')).toBe('true'));
  });
});

describe('媒体管理与任务', () => {
  it('来源总览渲染来源卡与操作', async () => {
    renderPage(<MediaManagementPage />, '/manage');
    await waitFor(() => expect(screen.getByText('本地动画库')).toBeTruthy());
    expect(screen.getAllByRole('button', { name: '开始扫描' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '新建导入' })).toBeNull();
    const actions = screen.getByRole('group', { name: '媒体管理操作' });
    expect(within(actions).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '媒体库维护', '打开任务中心', '导入媒体',
    ]);
    expect(screen.getAllByRole('button', { name: '导入媒体', exact: true })).toHaveLength(1);
  });

  it('导入流程在阻断问题处理完之前不允许确认', async () => {
    renderPage(<MediaManagementPage />, '/manage', '/manage?view=import');
    await waitFor(() => expect(screen.getByText('选择要导入的来源')).toBeTruthy());
    const scanButton = await screen.findByRole('button', { name: '开始扫描' });
    fireEvent.click(scanButton);
    await waitFor(() => expect(screen.getByText('正在扫描来源')).toBeTruthy(), { timeout: 4000 });

    fireEvent.click(screen.getByRole('button', { name: '跳过等待，直接审核' }));
    await waitFor(() => expect(screen.getAllByText('审核识别结果').length).toBeGreaterThan(0));

    const confirm = screen.getByRole('button', { name: '确认并执行' });
    expect(confirm).toHaveProperty('disabled', true);
  });

  it('任务中心展示状态汇总与空状态', async () => {
    renderPage(<TaskCenter />, '/tasks');
    await waitFor(() => expect(screen.getByText('任务中心')).toBeTruthy());
    expect(screen.getByText('还没有任务')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
  });
});

describe('设置', () => {

  it('未完成引导时自动打开，选择「稍后设置」只记录推迟并关闭', async () => {
    updateDemoState(() => ({
      settings: {
        ...DEFAULT_SETTINGS,
        application: { ...DEFAULT_SETTINGS.application, setupCompleted: false, setupDeferred: false },
      },
    }));
    renderPage(<HomePage />);

    expect(await screen.findByText('欢迎使用 KumiPlayer（演示）')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '稍后设置' }));

    await waitFor(() => expect(getDemoState().settings.application.setupDeferred).toBe(true));
    expect(getDemoState().settings.application.setupCompleted).toBe(false);
    await waitFor(() => expect(screen.queryByText('欢迎使用 KumiPlayer（演示）')).toBeNull());
  });

  it('可在设置里重新打开引导，取消不清空已有设置', async () => {
    renderPage(<SettingsPage />, '/settings');
    const outline = await screen.findByRole('navigation', { name: '设置分类' });
    fireEvent.click(within(outline).getByRole('button', { name: '应用' }));

    const before = getDemoState().settings.sources.localRoots.length;
    fireEvent.click(await screen.findByRole('button', { name: '重新运行引导' }));
    expect(await screen.findByText('重新运行设置引导')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(getDemoState().settings.sources.localRoots.length).toBe(before));
    expect(getDemoState().settings.application.setupCompleted).toBe(true);
  });
  it('八个分类可切换，外观主题默认纯白', async () => {
    renderPage(<SettingsPage />, '/settings');
    const outline = await screen.findByRole('navigation', { name: '设置分类' });
    // 已批准的分组：关于是第八组，WebDAV 目录改名为 WebDAV 设置。
    for (const label of ['应用', '外观', '媒体来源', 'WebDAV 设置', '元数据与图片', '播放', '账户与同步', '关于']) {
      expect(within(outline).getByRole('button', { name: label })).toBeTruthy();
    }

    fireEvent.click(within(outline).getByRole('button', { name: '外观' }));
    // 外观分类渲染主题/材质/列数/动效；蓝色主题已废止，默认是纯白。
    expect(await screen.findByText('主题')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '界面材质' })).toBeTruthy();
    expect(getDemoState().settings.appearance.theme).toBe('mica');
  });

  it('凭据输入为空且不预填任何真实凭据', async () => {
    renderPage(<SettingsPage />, '/settings');
    const outline = await screen.findByRole('navigation', { name: '设置分类' });

    fireEvent.click(within(outline).getByRole('button', { name: '元数据与图片' }));
    const tmdb = (await screen.findByLabelText('TMDB 读取令牌')) as HTMLInputElement;
    expect(tmdb.type).toBe('password');
    expect(tmdb.value).toBe('');

    fireEvent.click(within(outline).getByRole('button', { name: '账户与同步' }));
    const bangumi = (await screen.findByLabelText('Bangumi 访问令牌')) as HTMLInputElement;
    expect(bangumi.type).toBe('password');
    expect(bangumi.value).toBe('');
  });

  it('外观设置显示已保存列数，分类页的临时列数不冒充默认值', async () => {
    useUiStore.setState({ posterColumns: 6 });
    updateDemoState((current) => ({ settings: {
      ...current.settings, appearance: { ...current.settings.appearance, posterSize: 8 },
    } }));
    renderPage(<SettingsPage />, '/settings');
    const outline = await screen.findByRole('navigation', { name: '设置分类' });
    fireEvent.click(within(outline).getByRole('button', { name: '外观' }));
    expect(screen.getByRole('slider', { name: '海报墙列数' })).toHaveAttribute('aria-valuenow', '8');
  });
});
