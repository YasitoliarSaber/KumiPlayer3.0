import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import App from '../../src/App';
import { useConnectionStore } from '../../src/stores/connection';
import { useBangumiStore } from '../../src/stores/bangumi';
import { useLibraryStore } from '../../src/stores/library';
import { useUiStore } from '../../src/stores/ui';

const { renderCategory } = vi.hoisted(() => ({ renderCategory: vi.fn(() => <div>番剧墙</div>) }));
vi.mock('../../src/pages/CategoryPage', () => ({ default: renderCategory }));
vi.mock('../../src/pages/HomePage', () => ({ default: () => null }));
vi.mock('../../src/pages/FavoritesPage', () => ({ default: () => null }));
vi.mock('../../src/pages/RecentPage', () => ({ default: () => null }));
vi.mock('../../src/pages/SearchPage', () => ({ default: () => null }));
vi.mock('../../src/components/shell/StartupSplash', () => ({ default: () => null }));
vi.mock('../../src/components/shell/AppShell', () => ({ default: ({ children }: any) => <main>{children}</main> }));
vi.mock('@fluentui/react-components', () => ({ FluentProvider: ({ children }: any) => children }));
vi.mock('../../src/design/fluentTheme', () => ({ getKumiFluentTheme: () => ({}) }));
vi.mock('../../src/platform/fileDrop', () => ({ listenForTreeFileDrop: async () => () => {} }));
vi.mock('../../src/api/config', () => ({ configApi: { getConfig: async () => ({ setup_completed: true }) } }));

test('连接健康与账户状态更新不再从 App 重渲染整个分类页', async () => {
  useUiStore.setState({ page: 'category', activeCategory: 'anime_series', query: '' });
  useLibraryStore.setState({ loadLibrary: vi.fn().mockResolvedValue(true), syncChanges: vi.fn().mockResolvedValue(true) });
  useBangumiStore.setState({ restoreSession: vi.fn().mockResolvedValue(null), verifySession: vi.fn() });
  useConnectionStore.setState({ startHeartbeat: vi.fn(), stopHeartbeat: vi.fn(), startHealthPolling: vi.fn(), stopHealthPolling: vi.fn() });
  render(<App />);
  await waitFor(() => expect(renderCategory).toHaveBeenCalled());
  renderCategory.mockClear();
  act(() => useConnectionStore.setState({ checking: true }));
  act(() => useConnectionStore.setState({ backendOnline: true, checking: false }));
  act(() => useBangumiStore.setState({ connectivity: 'offline' }));
  expect(renderCategory).not.toHaveBeenCalled();
});

test('后台图片活动加快增量同步，空闲与后台降频，回到前台立即补齐且卸载停止', async () => {
  vi.useFakeTimers();
  const originalSync = useLibraryStore.getState().syncChanges;
  const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  const syncChanges = vi.fn().mockResolvedValue(true);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  useLibraryStore.setState({ syncChanges, loadLibrary: vi.fn().mockResolvedValue(true), backgroundActive: true, updating: false });
  useBangumiStore.setState({ restoreSession: vi.fn().mockResolvedValue(null), verifySession: vi.fn() });
  useConnectionStore.setState({ startHeartbeat: vi.fn(), stopHeartbeat: vi.fn(), startHealthPolling: vi.fn(), stopHealthPolling: vi.fn() });
  const view = render(<App />);
  try {
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(syncChanges).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(syncChanges).toHaveBeenCalledTimes(2);
    act(() => useLibraryStore.setState({ backgroundActive: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
    expect(syncChanges).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(syncChanges).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(syncChanges).toHaveBeenCalledTimes(4);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(syncChanges).toHaveBeenCalledTimes(5);
    act(() => useLibraryStore.setState({ backgroundActive: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(syncChanges).toHaveBeenCalledTimes(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(syncChanges).toHaveBeenCalledTimes(6);
    let resolve!: (value: boolean) => void;
    syncChanges.mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(syncChanges).toHaveBeenCalledTimes(7);
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(syncChanges).toHaveBeenCalledTimes(7);
    view.unmount();
    await act(async () => { resolve(true); await vi.advanceTimersByTimeAsync(60000); });
    fireEvent(document, new Event('visibilitychange'));
    expect(syncChanges).toHaveBeenCalledTimes(7);
  } finally {
    view.unmount();
    useLibraryStore.setState({ syncChanges: originalSync, backgroundActive: false });
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  }
});
