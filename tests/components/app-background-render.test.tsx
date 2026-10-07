import { act, render, waitFor } from '@testing-library/react';
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
  useLibraryStore.setState({ loadLibrary: vi.fn().mockResolvedValue(true) });
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
