import { beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FirstRunSetup from '../../src/pages/FirstRunSetup';
import { pickFolder } from '../../src/platform/folderPicker';

const api = vi.hoisted(() => ({
  getMpvRuntime: vi.fn(async () => ({
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
  })),
  completeSetup: vi.fn(),
  saveSetupPlayer: vi.fn(async () => ({})),
  saveSetupSources: vi.fn(async () => ({})),
  saveTmdbCredential: vi.fn(async () => ({})),
  saveBangumiToken: vi.fn(async () => {}),
  testMpv: vi.fn(async () => ({ ok: true, message: '播放器可用' })),
}));

vi.mock('../../src/api/config', () => ({ configApi: api }));
vi.mock('../../src/stores/bangumi', () => ({ useBangumiStore: (selector: (state: unknown) => unknown) => selector({ setToken: api.saveBangumiToken }) }));
vi.mock('../../src/platform/folderPicker', () => ({ pickFolder: vi.fn(), pickFile: vi.fn() }));
const closeWindow = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ close: closeWindow }) }));

const config = {
  mirror_dir: '',
  pan115_root: '',
  baidu_root: '',
  local_root: '',
  directory_tree_dir: '',
};

describe('FirstRunSetup V4 引导', () => {
  beforeEach(() => vi.clearAllMocks());

  test('首次引导可稍后设置，进入软件而不关闭应用', () => {
    const onCancel = vi.fn();
    render(<FirstRunSetup initialConfig={config as never} onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭引导，进入软件' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(closeWindow).not.toHaveBeenCalled();
    expect(api.completeSetup).not.toHaveBeenCalled();
  });

  test('验证失败可返回修改来源，也可直接回到播放器并关闭引导', async () => {
    api.completeSetup.mockRejectedValueOnce(new Error('媒体来源不可访问: 本地媒体'));
    const onCancel = vi.fn();
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:\\Missing' } as never} onComplete={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('内置播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '准备开始使用' });
    fireEvent.click(screen.getByRole('button', { name: /海报与观看同步/ }));
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('媒体来源不可访问');
    expect(screen.getByRole('textbox', { name: '本地媒体根目录' })).toHaveValue('D:\\Missing');
    fireEvent.click(screen.getByRole('button', { name: '返回播放器' }));
    expect(screen.getByRole('heading', { name: '选择播放器' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '关闭引导，进入软件' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('验证尚未结束仍可返回，迟到的结果不会把用户带离正在修改的步骤', async () => {
    let resolve!: (value: never) => void;
    api.completeSetup.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const onComplete = vi.fn();
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:\\Media' } as never} onComplete={onComplete} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('内置播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '准备开始使用' });
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await act(async () => { resolve({ ...config, setup_completed: true } as never); });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '本地媒体根目录' })).toBeVisible());
    expect(onComplete).not.toHaveBeenCalled();
  });

  test('内置不可用时可切换外部播放器，检测并提交选择；修改路径使检测失效', async () => {
    api.getMpvRuntime.mockResolvedValueOnce({ available: true, manifest_valid: false, files_valid: false, configuration_available: true, message: '运行时清单缺失' } as never);
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:\\Anime' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('运行时清单缺失');
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: '外部播放器' }));
    fireEvent.change(screen.getByRole('textbox', { name: '外部 MPV 路径' }), { target: { value: 'D:\\Player\\mpv.exe' } });
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    await screen.findByText('外部播放器已就绪');
    fireEvent.change(screen.getByRole('textbox', { name: '外部 MPV 路径' }), { target: { value: 'D:\\OtherPlayer' } });
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    await screen.findByText('外部播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '准备开始使用' });
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    await waitFor(() => expect(api.saveSetupPlayer).toHaveBeenCalledWith({ player_mode: 'external', external_mpv_path: 'D:\\OtherPlayer' }));
  });

  test('切换模式后忽略上一次尚未完成的检测结果', async () => {
    let resolveInternal!: (value: never) => void;
    api.getMpvRuntime.mockReturnValueOnce(new Promise((resolve) => { resolveInternal = resolve; }));
    render(<FirstRunSetup initialConfig={config as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('正在检测内置播放器…');
    fireEvent.click(screen.getByRole('radio', { name: '外部播放器' }));
    fireEvent.change(screen.getByRole('textbox', { name: '外部 MPV 路径' }), { target: { value: 'D:\\Player' } });
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    await screen.findByText('外部播放器已就绪');
    resolveInternal({ available: false, message: '旧检测失败' } as never);
    await waitFor(() => expect(screen.getByRole('button', { name: '继续' })).toBeEnabled());
    expect(screen.queryByText('旧检测失败')).not.toBeInTheDocument();
  });

  test('简化欢迎说明，并把 OpenList 明确为完成后的接入配置', async () => {
    render(<FirstRunSetup initialConfig={config as never} onComplete={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText(/不会移动或改名你的原始文件/)).toBeVisible();
    expect(screen.getByText(/配置可以随时修改/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('内置播放器已就绪')).toBeVisible();
    expect(screen.queryByText('mpv 0.40.0')).not.toBeInTheDocument();
    expect(screen.queryByText('x86_64-pc-windows-msvc')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('OpenList 可在完成后添加')).toBeVisible();
    expect(screen.getByText(/先选择一个本地或已挂载的媒体目录/)).toBeVisible();
  });

  test('先选来源类型，切换时保留每种来源的路径并一起提交', async () => {
    render(<FirstRunSetup initialConfig={{ ...config, mirror_dir: 'D:\\Mirror', local_root: 'D:\\Anime', pan115_root: 'H:\\115' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('内置播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    expect(screen.getByRole('textbox', { name: '本地媒体根目录' })).toHaveValue('D:\\Anime');
    expect(screen.queryByRole('textbox', { name: '115 网盘挂载根目录' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /115 网盘/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '115 网盘挂载根目录' }), { target: { value: 'H:\\Media' } });
    fireEvent.click(screen.getByRole('radio', { name: /本地文件夹/ }));
    expect(screen.getByRole('textbox', { name: '本地媒体根目录' })).toHaveValue('D:\\Anime');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '准备开始使用' });
    expect(screen.queryByLabelText('TMDB API 读取访问令牌')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /海报与观看同步/ }));
    expect(screen.getByLabelText('TMDB API 读取访问令牌')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    await waitFor(() => expect(api.saveSetupSources).toHaveBeenCalledWith(expect.objectContaining({ local_root: 'D:\\Anime', pan115_root: 'H:\\Media' })));
    expect(api.completeSetup.mock.calls[0][0]).not.toHaveProperty('tmdb_bearer_token');
    expect(api.completeSetup.mock.calls[0][0]).not.toHaveProperty('bangumi_access_token');
    expect(api.completeSetup).toHaveBeenCalledWith({});
  });

  test('文件夹选择失败时可见报错，手动输入仍然可用', async () => {
    vi.mocked(pickFolder).mockRejectedValueOnce(new Error('目录选择不可用'));
    render(<FirstRunSetup initialConfig={config as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('内置播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    fireEvent.click(screen.getByRole('button', { name: '选择本地媒体根目录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('目录选择不可用');
    fireEvent.change(screen.getByRole('textbox', { name: '本地媒体根目录' }), { target: { value: 'D:\\Anime' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '镜像目录（必填）' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  });

  test('重新引导检查当前外部播放器，不将它误报为内置播放器', async () => {
    render(<FirstRunSetup initialConfig={{ ...config, player_mode: 'external', external_mpv_path: 'D:\\Player\\mpv.exe' } as never} onComplete={vi.fn()} onCancel={vi.fn()} mode="reconfigure" />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('外部播放器已就绪')).toBeVisible();
    expect(api.testMpv).toHaveBeenCalledWith('D:\\Player\\mpv.exe', 'external');
    expect(api.getMpvRuntime).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  });

  test('外部播放器检测失败时阻止继续，重新检测成功后恢复', async () => {
    api.testMpv.mockResolvedValueOnce({ ok: false, message: '找不到播放器' });
    render(<FirstRunSetup initialConfig={{ ...config, player_mode: 'external', external_mpv_path: 'D:\\Player\\mpv.exe' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('播放器暂不可用')).toBeVisible();
    expect(screen.getByText('找不到播放器')).toBeVisible();
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    expect(await screen.findByText('外部播放器已就绪')).toBeVisible();
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
    expect(api.getMpvRuntime).not.toHaveBeenCalled();
  });

  test('旧版外部播放器配置沿用已保存的 mpv_path', async () => {
    render(<FirstRunSetup initialConfig={{ ...config, player_mode: 'external', external_mpv_path: '', mpv_path: 'D:\\Player\\mpv.exe' } as never} onComplete={vi.fn()} onCancel={vi.fn()} mode="reconfigure" />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByText('外部播放器已就绪')).toBeVisible();
    expect(api.testMpv).toHaveBeenCalledWith('D:\\Player\\mpv.exe', 'external');
    expect(api.getMpvRuntime).not.toHaveBeenCalled();
  });

  test('只有镜像目录不能进入下一步，至少需要一个实际媒体来源', async () => {
    render(<FirstRunSetup initialConfig={{ ...config, mirror_dir: 'D:\\Mirror' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('内置播放器已就绪');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '你的媒体放在哪里' });
    expect(screen.getByRole('button', { name: '继续' })).toBeDisabled();
    expect(screen.queryByLabelText('目录树文件目录（可选）')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /百度网盘/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '百度网盘挂载位置' }), { target: { value: 'H:\\Baidu' } });
    expect(screen.getByRole('button', { name: '继续' })).toBeEnabled();
  });
});


async function reachSources() {
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByText('内置播放器已就绪');
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByRole('heading', { name: '你的媒体放在哪里' });
}

async function reachCredentials() {
  await reachSources();
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByRole('heading', { name: '准备开始使用' });
  fireEvent.click(screen.getByRole('button', { name: /海报与观看同步/ }));
}

describe('逐项验证与保存', () => {
  beforeEach(() => vi.clearAllMocks());

  test('继续时验证尚未保存的目录，失败停在来源步骤并保留输入', async () => {
    api.saveSetupSources.mockRejectedValueOnce(new Error('本地媒体目录不存在或不可访问：D:/Missing'));
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:/Missing' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachSources();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('D:/Missing');
    expect(screen.getByRole('textbox', { name: '本地媒体根目录' })).toHaveValue('D:/Missing');
    expect(screen.queryByRole('heading', { name: '准备开始使用' })).not.toBeInTheDocument();
    expect(api.completeSetup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '本地媒体根目录' }), { target: { value: 'D:/Media' } });
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByText('已验证并保存 1 个来源');
    expect(api.saveSetupSources).toHaveBeenLastCalledWith(expect.objectContaining({ local_root: 'D:/Media' }));
  });

  test('目录检查等待时仍可返回，迟到结果不能再次跳步', async () => {
    let resolve!: (value: object) => void;
    api.saveSetupSources.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:/Media' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachSources();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('button', { name: '正在检查目录…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await act(async () => resolve({}));
    expect(screen.getByRole('heading', { name: '选择播放器' })).toBeVisible();
  });

  test('TMDB 与 Bangumi 分别验证并保存，来源失败后保存结果仍保留', async () => {
    api.completeSetup.mockRejectedValueOnce(new Error('本地媒体目录不存在或不可访问：D:/Media'));
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:/Media' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachCredentials();
    fireEvent.change(screen.getByLabelText('TMDB API 读取访问令牌'), { target: { value: 'fixture:tmdb-read-token' } });
    fireEvent.change(screen.getByLabelText('Bangumi 个人访问令牌'), { target: { value: 'fixture:bangumi-token' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并保存 TMDB' }));
    await waitFor(() => expect(screen.getByLabelText('TMDB API 读取访问令牌')).toHaveValue(''));
    expect(api.saveTmdbCredential).toHaveBeenCalledWith('fixture:tmdb-read-token');
    expect(screen.getByLabelText('Bangumi 个人访问令牌')).toHaveValue('fixture:bangumi-token');
    fireEvent.click(screen.getByRole('button', { name: '验证并保存 Bangumi' }));
    await waitFor(() => expect(screen.getByLabelText('Bangumi 个人访问令牌')).toHaveValue(''));
    expect(api.saveBangumiToken).toHaveBeenCalledWith('fixture:bangumi-token');
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    await screen.findByRole('textbox', { name: '本地媒体根目录' });
    expect(api.completeSetup.mock.calls[0][0]).not.toHaveProperty('tmdb_bearer_token');
    expect(api.completeSetup.mock.calls[0][0]).not.toHaveProperty('bangumi_access_token');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await screen.findByRole('heading', { name: '准备开始使用' });
    fireEvent.click(screen.getByRole('button', { name: /海报与观看同步/ }));
    expect(screen.getAllByPlaceholderText('已保存；输入新令牌可替换')).toHaveLength(2);
  });

  test('单项验证失败保留令牌便于重试，不调用最后一步', async () => {
    api.saveTmdbCredential.mockRejectedValueOnce(new Error('认证失败，请检查令牌'));
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:/Media' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachCredentials();
    fireEvent.change(screen.getByLabelText('TMDB API 读取访问令牌'), { target: { value: 'fixture:bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并保存 TMDB' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('认证失败');
    expect(screen.getByLabelText('TMDB API 读取访问令牌')).toHaveValue('fixture:bad-token');
    expect(api.completeSetup).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
  });

  test('完成前提示分别保存新令牌，避免默默丢弃输入', async () => {
    render(<FirstRunSetup initialConfig={{ ...config, local_root: 'D:/Media' } as never} onComplete={vi.fn()} onCancel={vi.fn()} />);
    await reachCredentials();
    fireEvent.change(screen.getByLabelText('Bangumi 个人访问令牌'), { target: { value: 'fixture:unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并完成' }));
    expect(screen.getByRole('alert')).toHaveTextContent('验证并保存');
    expect(api.completeSetup).not.toHaveBeenCalled();
  });


test('外部播放器验证成功即保存，直接稍后设置也保留选择', async () => {
  const onCancel = vi.fn();
  render(<FirstRunSetup initialConfig={{ ...config, player_mode: 'external', external_mpv_path: 'D:/Player/mpv.exe' } as never} onComplete={vi.fn()} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  await screen.findByText('外部播放器已就绪');
  expect(api.saveSetupPlayer).toHaveBeenCalledWith({ player_mode: 'external', external_mpv_path: 'D:/Player/mpv.exe' });
  fireEvent.click(screen.getByRole('button', { name: '关闭引导，进入软件' }));
  expect(onCancel).toHaveBeenCalledOnce();
});

test('播放器保存失败时仍可返回与关闭，不误进入来源步骤', async () => {
  api.saveSetupPlayer.mockRejectedValueOnce(new Error('模拟写入失败'));
  const onCancel = vi.fn();
  render(<FirstRunSetup initialConfig={config as never} onComplete={vi.fn()} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole('button', { name: '继续' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('模拟写入失败');
  expect(screen.getByRole('heading', { name: '选择播放器' })).toBeVisible();
  expect(screen.getByRole('button', { name: '返回' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '关闭引导，进入软件' }));
  expect(onCancel).toHaveBeenCalledOnce();
});

});
