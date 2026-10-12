import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import App from '../../src/App';
import { useConnectionStore } from '../../src/stores/connection';
import { useBangumiStore } from '../../src/stores/bangumi';
import { useLibraryStore } from '../../src/stores/library';
import { useUiStore } from '../../src/stores/ui';

const api = vi.hoisted(() => ({ getConfig: vi.fn(), deferSetup: vi.fn() }));
vi.mock('../../src/api/config', () => ({ configApi: api }));
vi.mock('../../src/pages/HomePage', () => ({ default: () => <div>媒体库首页</div> }));
vi.mock('../../src/pages/SettingsPage', () => ({ default: ({ onOpenSetup }: any) => <button onClick={() => onOpenSetup({ setup_deferred: true, setup_completed: false, local_root: 'recently-saved' })}>打开设置引导</button> }));
vi.mock('../../src/pages/FirstRunSetup', () => ({ default: ({ onCancel, initialConfig }: any) => <section aria-label="设置引导"><span>{initialConfig.local_root}</span><button onClick={onCancel}>稍后设置</button></section> }));
vi.mock('../../src/components/shell/StartupSplash', () => ({ default: () => null }));
vi.mock('../../src/components/shell/AppShell', () => ({ default: ({ children }: any) => <main aria-label="软件主窗口">{children}</main> }));
vi.mock('@fluentui/react-components', () => ({ FluentProvider: ({ children }: any) => children }));
vi.mock('../../src/design/fluentTheme', () => ({ getKumiFluentTheme: () => ({}) }));
vi.mock('../../src/platform/fileDrop', () => ({ listenForTreeFileDrop: async () => () => {} }));

beforeEach(() => {
  vi.clearAllMocks();
  api.getConfig.mockResolvedValue({ setup_completed: false, setup_deferred: false });
  api.deferSetup.mockResolvedValue({ setup_completed: false, setup_deferred: true });
  useUiStore.setState({ page: 'home', query: '' });
  useLibraryStore.setState({ loadLibrary: vi.fn().mockResolvedValue(true), syncChanges: vi.fn().mockResolvedValue(false) });
  useBangumiStore.setState({ restoreSession: vi.fn().mockResolvedValue(null), verifySession: vi.fn() });
  useConnectionStore.setState({ startHeartbeat: vi.fn(), stopHeartbeat: vi.fn(), startHealthPolling: vi.fn(), stopHealthPolling: vi.fn() });
});

test('首次引导共用主窗口，稍后设置进入首页并启用媒体库', async () => {
  render(<App />);
  expect(await screen.findByRole('region', { name: '设置引导' })).toBeInTheDocument();
  expect(screen.getByRole('main', { name: '软件主窗口' })).toBeInTheDocument();
  expect(useConnectionStore.getState().startHeartbeat).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '稍后设置' }));
  expect(await screen.findByText('媒体库首页')).toBeVisible();
  expect(api.deferSetup).toHaveBeenCalledOnce();
  expect(useLibraryStore.getState().loadLibrary).toHaveBeenCalledOnce();
});

test('保存稍后设置后的下次启动进入首页，设置可用最新配置重新打开引导', async () => {
  api.getConfig.mockResolvedValue({ setup_completed: false, setup_deferred: true, local_root: 'old' });
  render(<App />);
  expect(await screen.findByText('媒体库首页')).toBeVisible();
  act(() => useUiStore.setState({ page: 'settings' }));
  fireEvent.click(await screen.findByRole('button', { name: '打开设置引导' }));
  expect(await screen.findByRole('region', { name: '设置引导' })).toBeInTheDocument();
  expect(screen.getByText('recently-saved')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '稍后设置' }));
  expect(await screen.findByRole('button', { name: '打开设置引导' })).toBeVisible();
  expect(api.deferSetup).not.toHaveBeenCalled();
});

test('后台保存失败也能立即离开引导，不会困在出错页面', async () => {
  api.deferSetup.mockRejectedValue(new Error('offline'));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: '稍后设置' }));
  expect(await screen.findByText('媒体库首页')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('未能保存'));
  expect(screen.queryByRole('region', { name: '设置引导' })).not.toBeInTheDocument();
});

test('引导期间应用导航可直接进入设置，播放器未就绪也不会拦截', async () => {
  render(<App />);
  await screen.findByRole('region', { name: '设置引导' });
  act(() => useUiStore.setState({ page: 'settings' }));
  expect(await screen.findByRole('button', { name: '打开设置引导' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '设置引导' })).not.toBeInTheDocument();
  expect(api.deferSetup).toHaveBeenCalledOnce();
});
