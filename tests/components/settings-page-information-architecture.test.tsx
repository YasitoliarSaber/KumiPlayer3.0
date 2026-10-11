import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SettingsPage from '../../src/pages/SettingsPage';
import { pickFolder } from '../../src/platform/folderPicker';
vi.mock('../../src/platform/folderPicker', () => ({ pickFolder: vi.fn(), pickFile: vi.fn() }));

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getMpvRuntime: vi.fn(),
  testMediaPaths: vi.fn(),
  patchConfig: vi.fn(),
  testMpv: vi.fn(),
  testTmdb: vi.fn(),
  openMpvConfigDir: vi.fn(),
  setOngoingCategoryName: vi.fn((name: string) => name.trim() || '新番'),
  setPosterWallLayout: vi.fn(),
}));

vi.mock('../../src/api/config', () => ({ configApi: api }));
vi.mock('../../src/api/tasks', () => ({ tasksApi: { list: vi.fn(async () => ({ tasks: [] })) } }));
vi.mock('../../src/api/openlist', () => ({
  openlistApi: {
    getRoutes: vi.fn(async () => ({ routes: [] })),
    discoverRoutes: vi.fn(async () => ({ items: [] })),
    saveConfig: vi.fn(),
    testConnection: vi.fn(),
    saveRoutes: vi.fn(),
  },
}));
vi.mock('../../src/stores/bangumi', () => ({
  useBangumiStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      user: null,
      isLoggedIn: false,
      hasStoredCredential: false,
      credentialState: 'not_found',
      authStatus: 'unknown',
      connectivity: 'unknown',
      lastSuccessAt: '',
      loading: false,
      error: null,
      sessionStatus: 'signed_out',
      restoreSession: vi.fn(),
      verifySession: vi.fn(),
      setToken: vi.fn(),
      clearToken: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../src/stores/library', () => ({
  useLibraryStore: (selector: (state: unknown) => unknown) => selector({ loadLibrary: vi.fn() }),
}));
vi.mock('../../src/stores/ui', () => ({
  useUiStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      appearanceMode: 'fluent',
      ongoingCategoryName: '新番',
      setOngoingCategoryName: api.setOngoingCategoryName,
      setAppearanceMode: vi.fn(),
      setPosterWallLayout: api.setPosterWallLayout,
      goPlayerTuning: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../src/components/settings/OpenListSettingsPanel', () => ({
  default: ({ config }: { config: { openlist_server_url: string } }) => <div data-testid="openlist-settings-panel">既有 OpenList 连接设置<span>{config.openlist_server_url}</span></div>,
}));
vi.mock('../../src/components/settings/OpenListSourceRoutes', () => ({
  default: () => <div data-testid="openlist-source-routes">既有 OpenList 来源目录</div>,
}));

const config = {
  player_mode: 'internal',
  external_mpv_path: '',
  mpv_anime4k_mode: 'off',
  mpv_anime4k_quality: 'balanced',
  poster_size: 180,
  series_card_image_mode: 'poster',
  heartbeat_enabled: true,
  heartbeat_timeout: 30,
  auto_shutdown_on_heartbeat_timeout: false,
  openlist_configured: true,
  openlist_server_url: 'https://openlist.example.test',
  openlist_remote_root: '/',
  openlist_mount_root: 'K:\\',
  openlist_cache_ttl_minutes: 1440,
  openlist_prefetch_limit: 12,
  pan115_root: 'K:\\115',
  baidu_root: 'K:\\Baidu',
  local_root: 'D:\\Media',
  directory_tree_dir: 'D:\\Trees',
  mirror_dir: 'D:\\Mirror',
};

describe('SettingsPage 信息架构', () => {
  test('令牌输入和数值设置具有可访问标签，保存仍只修改对应字段', async () => {
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Bangumi 个人访问令牌')).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: '元数据与图片' }));
    fireEvent.click(screen.getByText('高级参数'));
    const timeout = screen.getByRole('spinbutton', { name: 'TMDB 超时' });
    fireEvent.change(timeout, { target: { value: '25' } });
    fireEvent.click(within(timeout.closest('.settings-config-row')!).getByRole('button', { name: '保存' }));
    expect(api.patchConfig).toHaveBeenCalledWith({ tmdb_timeout: 25 });
  });
  test('分类名称保存复用本机UI偏好，不写后台配置', async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    api.patchConfig.mockClear();
    api.setOngoingCategoryName.mockClear();
    fireEvent.change(screen.getByRole('textbox', { name: '分类名称' }), { target: { value: '连载剧集' } });
    fireEvent.click(screen.getByRole('button', { name: '保存分类名称' }));
    expect(api.setOngoingCategoryName).toHaveBeenCalledExactlyOnceWith('连载剧集');
    expect(api.patchConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('分类名称已保存');
  });

  test('新番自动更新仅在媒体来源设置，默认关闭且两项独立保存', async () => {
    let saved = { ...config, ongoing_update_on_startup: false, ongoing_update_interval_minutes: 0 };
    api.patchConfig.mockImplementation(async patch => {
      saved = { ...saved, ...patch };
      return saved;
    });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    const startup = screen.getByRole('switch', { name: '启动时更新新番' });
    const interval = screen.getByRole('combobox', { name: '新番更新间隔' });
    expect(startup).not.toBeChecked();
    expect(interval).toHaveTextContent('关闭');
    api.patchConfig.mockClear();
    fireEvent.click(startup);
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ ongoing_update_on_startup: true }));
    await waitFor(() => expect(startup).toBeChecked());
    fireEvent.click(interval);
    fireEvent.click(screen.getByRole('option', { name: '每小时' }));
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ ongoing_update_interval_minutes: 60 }));
    await waitFor(() => expect(interval).toHaveTextContent('每小时'));
    expect(startup).toBeChecked();
    expect(screen.getByText(/TXT 需手动导入新清单/)).toBeVisible();
    expect(document.getElementById('settings-panel-sources')).toContainElement(startup);
    expect(document.getElementById('settings-panel-openlist')).not.toContainElement(startup);
  });

  test('新番设置保存失败显示错误且不宣称已启用', async () => {
    api.patchConfig.mockRejectedValueOnce(new Error('模拟保存失败'));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    const startup = screen.getByRole('switch', { name: '启动时更新新番' });
    fireEvent.click(startup);
    expect(await screen.findByRole('alert')).toHaveTextContent('模拟保存失败');
    expect(startup).not.toBeChecked();
    expect(screen.queryByText('新番更新设置已保存')).not.toBeInTheDocument();
  });

  test('联网名称核对复用元数据分类，默认关闭并独立保存密钥', async () => {
    api.getConfig.mockResolvedValue({ ...config, alias_web_recovery_enabled: false, websearch_configured: true, deepseek_configured: true });
    api.patchConfig.mockImplementation(async (patch) => ({ ...config, ...patch, websearch_configured: true, deepseek_configured: true }));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '元数据与图片' }));
    fireEvent.click(screen.getByText('联网名称核对（可选）'));
    expect(screen.getByRole('combobox', { name: '联网名称核对' })).toHaveTextContent('关闭（默认）');
    expect(screen.getByLabelText('Tavily 搜索密钥')).toHaveValue('');
    expect(screen.getByLabelText('DeepSeek 密钥')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Tavily 搜索密钥'), { target: { value: 'fixture-search' } });
    fireEvent.click(within(screen.getByLabelText('Tavily 搜索密钥').closest('.settings-config-row')!).getByRole('button', { name: '保存' }));
    expect(api.patchConfig).toHaveBeenCalledWith({ websearch_api_key: 'fixture-search' });
    expect(screen.getByText(/只发送作品名称与年份/)).toBeVisible();
  });
  beforeEach(() => {
    api.getConfig.mockResolvedValue(config);
    api.getMpvRuntime.mockResolvedValue({
      available: true,
      version: 'mpv 0.40.0',
      architecture: 'x86_64-pc-windows-msvc',
      target_triple: 'x86_64-pc-windows-msvc',
      manifest_valid: true,
      files_valid: true,
      configuration_available: true,
      scripts_available: true,
      distribution_status: 'development-only',
      message: '内置播放器已就绪',
    });
    Element.prototype.scrollIntoView = vi.fn();
    (globalThis as typeof globalThis & { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  test('OpenList 设置导航定位到既有 OpenList 面板，媒体来源不再重复展示', async () => {
    render(<SettingsPage />);

    const openListNavigation = await screen.findByRole('button', { name: /OpenList 设置/ });
    const openListSection = document.getElementById('settings-panel-openlist');
    const sourceSection = document.getElementById('settings-panel-sources');

    expect(openListSection).toContainElement(screen.getByTestId('openlist-settings-panel'));
    expect(openListSection).toContainElement(screen.getByTestId('openlist-source-routes'));
    expect(sourceSection).not.toContainElement(screen.getByTestId('openlist-settings-panel'));
    expect(sourceSection).not.toContainElement(screen.getByTestId('openlist-source-routes'));

    fireEvent.click(openListNavigation);

    expect(openListSection).toBeVisible();
    expect(sourceSection).not.toBeVisible();
    expect(openListNavigation).toHaveAttribute('aria-current', 'location');
  });

  test('设置分类复用原面板并切换到独立连接', async () => {
    const b = { ...config, connection_id: 'ol-b', name: '连接乙', openlist_server_url: 'https://second.example.test', openlist_routes: [] };
    api.getConfig.mockResolvedValue({ ...config, openlist_connections: [
      { ...config, connection_id: 'legacy', name: '连接甲', openlist_routes: [] }, b,
    ] });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'OpenList 设置' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'OpenList 连接' }));
    fireEvent.click(await screen.findByRole('option', { name: '连接乙' }));
    expect(await screen.findByText('https://second.example.test')).toBeVisible();
    expect(screen.queryByText('https://openlist.example.test')).not.toBeInTheDocument();
  });

  test('按 V4 数据流保留稳定设置分类，并将联网与重配入口放在对应位置', async () => {
    render(<SettingsPage />);

    const navigation = screen.getByRole('navigation', { name: '设置分类' });
    expect(await within(navigation).findByRole('button', { name: /媒体来源/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /账户与同步/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /元数据与图片/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /播放/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /外观/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '应用', exact: true })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: /应用与支持/ })).not.toBeInTheDocument();
    expect(document.getElementById('settings-panel-sources')).toHaveTextContent('115 网盘挂载位置');
    expect(document.getElementById('settings-panel-sources')).toHaveTextContent('来源维护');
    expect(document.getElementById('settings-panel-sources')).not.toHaveTextContent('镜像目录');
    expect(document.getElementById('settings-panel-sources')).toHaveTextContent('打开首次设置');
    expect(document.getElementById('settings-panel-scrape')).toHaveTextContent('网络代理');
  });

  test('作品墙布局归属外观分类，窗口设置独立归属应用分类', async () => {
    render(<SettingsPage />);

    const navigation = screen.getByRole('navigation', { name: '设置分类' });
    await within(navigation).findByRole('button', { name: /外观/ });
    expect(within(navigation).getAllByRole('button')).toHaveLength(7);

    api.patchConfig.mockClear();
    fireEvent.click(within(navigation).getByRole('button', { name: /外观/ }));
    const appearance = document.getElementById('settings-panel-appearance')!;
    expect(within(appearance).getByText('作品墙布局')).toBeVisible();
    expect(within(appearance).getByText('应用主题')).toBeVisible();
    expect(appearance).not.toHaveTextContent('窗口与托盘');
    expect(appearance).not.toHaveTextContent('界面连接监测');
    // 默认 180 等价于目标 5 列，保留旧偏好而不强行改成预设。
    expect(within(appearance).getByRole('combobox', { name: '封面比例' })).toHaveTextContent('竖版封面');
    expect(within(appearance).getByRole('combobox', { name: '封面大小' })).toHaveTextContent('5 列');
    expect(within(appearance).getByRole('button', { name: '应用', exact: true })).toBeDisabled();
    expect(within(appearance).getByRole('button', { name: '还原', exact: true })).toBeDisabled();
    expect(api.patchConfig).not.toHaveBeenCalled();
  });

  test('应用与外观位于账户之后，媒体来源之前', async () => {    render(<SettingsPage />);

    const navigation = screen.getByRole('navigation', { name: '设置分类' });
    const labels = within(navigation)
      .getAllByRole('button')
      .map((button) => button.textContent || '');

    expect(labels.indexOf('账户与同步')).toBeLessThan(labels.indexOf('应用'));
    expect(labels.indexOf('应用')).toBeLessThan(labels.indexOf('外观'));
    expect(labels.findIndex((label) => label.includes('外观'))).toBeLessThan(labels.findIndex((label) => label.includes('媒体来源')));
  });

  test('图片缓存独立于来源，不提供远程图片运行模式且不重写历史配置', async () => {
    api.getConfig.mockResolvedValue({ ...config, artwork_storage_mode: 'local' });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '元数据与图片' }));
    expect(screen.queryByRole('combobox', { name: '图片策略' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '图片策略' })).not.toBeInTheDocument();
    api.patchConfig.mockClear();
    expect(api.patchConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '外观', exact: true }));
    expect(screen.getByRole('button', { name: /雾蓝云母/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /深邃影院/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: '元数据与图片' }));
    expect(screen.queryByRole('heading', { name: '图片策略' })).not.toBeInTheDocument();
    expect(api.patchConfig).not.toHaveBeenCalled();
  });

  test('隐藏构建与赞助信息，并将播放器状态收敛为用户可理解的结果', async () => {
    render(<SettingsPage />);

    await screen.findByRole('button', { name: /OpenList 设置/ });
    fireEvent.click(screen.getByRole('button', { name: /^播放$/ }));

    expect(screen.queryByText('构建来源')).not.toBeInTheDocument();
    expect(screen.queryByText('支持与赞助')).not.toBeInTheDocument();
    expect(screen.queryByText('KumiPlayer 构建标识')).not.toBeInTheDocument();
    expect(screen.getByText('KumiPlayer 内置播放器')).toBeVisible();
    expect(screen.getByText('内置播放器已就绪')).toBeVisible();
    expect(screen.queryByText('x86_64-pc-windows-msvc')).not.toBeInTheDocument();
    expect(screen.queryByText(/清单：/)).not.toBeInTheDocument();
  });

  test('播放分类直接选择播放器与画质，保存外部模式不会覆盖内置画质', async () => {
    api.patchConfig.mockImplementation(async patch => ({ ...config, ...patch }));
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '播放' }));
    expect(screen.getByText('KumiPlayer 内置播放器')).toBeVisible();
    expect(screen.getByRole('combobox', { name: '模式' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '播放器与画质设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: '外部 MPV 整合包' }));
    fireEvent.change(screen.getByLabelText('整合包 MPV 可执行文件'), { target: { value: 'J:/Pack/mpv.exe' } });
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }));
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ player_mode: 'external', external_mpv_path: 'J:/Pack/mpv.exe' }));
    expect(screen.getByRole('radio', { name: '外部 MPV 整合包' })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: '模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '画面效果与播放联动' })).not.toBeInTheDocument();
  });

  test('连接监测保留操作而不堆叠说明，修改连续播放不会清掉播放器草稿', async () => {
    api.patchConfig.mockImplementation(async patch => ({ ...config, ...patch }));
    render(<SettingsPage />);
    const navigation = screen.getByRole('navigation', { name: '设置分类' });
    fireEvent.click(await within(navigation).findByRole('button', { name: '应用', exact: true }));
    const application = document.getElementById('settings-panel-application')!;
    expect(application).toBeVisible();
    expect(within(application).getByText('窗口与托盘')).toBeVisible();
    expect(application).not.toHaveTextContent('应用主题');
    expect(application).not.toHaveTextContent('连续播放');
    expect(screen.getByRole('switch', { name: '界面连接监测' })).toBeEnabled();
    expect(screen.getByText('界面连接监测', { selector: 'label' })).toBeVisible();
    expect(screen.getByRole('switch', { name: '连接超时后退出空闲后台' })).toBeEnabled();
    expect(screen.getByText('连接超时后退出空闲后台', { selector: 'label' })).toBeVisible();
    expect(screen.queryByText(/界面定期向后台服务发送连接信号/)).not.toBeInTheDocument();
    expect(screen.queryByText(/选择播放器，再调整它的默认效果/)).not.toBeInTheDocument();
    expect(screen.queryByText('播放心跳')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: '界面连接监测' }));
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ heartbeat_enabled: false }));
    await waitFor(() => expect(screen.getByRole('switch', { name: '界面连接监测' })).not.toBeChecked());
    fireEvent.click(within(navigation).getByRole('button', { name: '播放' }));
    expect(document.getElementById('settings-panel-player')).not.toHaveTextContent('界面连接监测');
    fireEvent.click(screen.getByRole('radio', { name: '外部 MPV 整合包' }));
    fireEvent.change(screen.getByLabelText('整合包 MPV 可执行文件'), { target: { value: 'J:/Pack/mpv.exe' } });
    fireEvent.click(screen.getByRole('switch', { name: '自动播放下一集' }));
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ auto_play_next_episode: true }));
    expect(screen.getByLabelText('整合包 MPV 可执行文件')).toHaveValue('J:/Pack/mpv.exe');
  });

  test('切换分类显示单个面板，并返回内容顶部', async () => {
    const scrollTo = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    HTMLElement.prototype.scrollTo = scrollTo;
    render(<div className="app-main"><SettingsPage /></div>);

    fireEvent.click(await screen.findByRole('button', { name: /OpenList 设置/ }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(document.getElementById('settings-panel-openlist')).toBeVisible();
    expect(document.getElementById('settings-panel-bangumi')).not.toBeVisible();
  });

  test('来源配置按播放位置、扫描目录、文件选择和维护分组，标题下无描述', async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    const mounts = screen.getByRole('region', { name: '目录树播放位置' });
    expect(within(mounts).getByRole('textbox', { name: '百度网盘挂载位置' })).toBeVisible();
    expect(within(mounts).queryByRole('textbox', { name: 'TXT 默认选择目录' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '本地扫描目录' })).toBeVisible();
    expect(screen.getByLabelText('TXT 默认选择目录')).not.toBeVisible();
    expect(screen.getByRole('button', { name: '检查配置目录', hidden: true })).not.toBeVisible();
    expect(screen.queryByRole('heading', { name: '重新配置基础来源' })).not.toBeInTheDocument();
    expect(document.querySelector('#settings-panel-sources .settings-intro p')).toBeNull();
  });

  test('选择夸克挂载文件夹只更新草稿，保存时不改动其他来源', async () => {
    vi.mocked(pickFolder).mockResolvedValueOnce('J:\\夸克');
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    const input = screen.getByRole('textbox', { name: '夸克网盘挂载位置' });
    api.patchConfig.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '选择夸克网盘挂载位置' }));
    await screen.findByDisplayValue('J:\\夸克');
    expect(api.patchConfig).not.toHaveBeenCalled();
    fireEvent.click(within(input.closest('.settings-config-row')!).getByRole('button', { name: '保存' }));
    expect(api.patchConfig).toHaveBeenCalledWith({ quark_root: 'J:\\夸克' });
  });

  test('本地路径均可选择文件夹，取消选择保留手动草稿', async () => {
    vi.mocked(pickFolder).mockResolvedValueOnce(null);
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: '媒体来源' }));
    fireEvent.click(screen.getByText('TXT 文件选择', { selector: 'summary h3' }));
    for (const name of ['115 网盘挂载位置', '百度网盘挂载位置', '夸克网盘挂载位置', '本地扫描目录', 'TXT 默认选择目录']) {
      expect(screen.getByRole('button', { name: `选择${name}` })).toBeVisible();
    }
    const input = screen.getByRole('textbox', { name: '115 网盘挂载位置' });
    fireEvent.change(input, { target: { value: 'J:\\115' } });
    fireEvent.click(screen.getByRole('button', { name: '选择115 网盘挂载位置' }));
    await screen.findByRole('button', { name: '选择115 网盘挂载位置', disabled: false });
    expect(input).toHaveValue('J:\\115');
    expect(pickFolder).toHaveBeenLastCalledWith('J:\\115', '选择115 网盘挂载位置');
  });
});
